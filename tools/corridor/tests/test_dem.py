"""dem: one product per tile, and a cache safe to share across concurrent bakes.

Two failures behind these tests. The first: a multi-county bbox returned the same 10 km tile as two
to four vintages (Fairfax 2018, Sandy NCR 2014, NorthernVA B22, Central Processing D24), so the bake
downloaded and cached several copies of identical ground and a rerun looked like it was
re-downloading everything (dc-metro-take-2, 2026-10-05). The second: the shared cache is
ReadWriteMany and every concurrent bake holds it, so `download` must publish without a lock and
without a shared `.part`.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import dem  # noqa: E402


class FakeResp:
    def __init__(self, body: bytes, status: int = 200, on_chunk=None):
        self.body, self.status_code, self.on_chunk = body, status, on_chunk

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            if self.on_chunk:
                self.on_chunk()
            yield self.body[i:i + n]


class FakeSession:
    def __init__(self, body: bytes, status: int = 200, on_chunk=None):
        self.body, self.status, self.on_chunk = body, status, on_chunk
        self.calls: list[str] = []

    def get(self, url, **kw):
        self.calls.append(url)
        return FakeResp(self.body, self.status, self.on_chunk)


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.saved = dem.session

    def tearDown(self):
        dem.session = self.saved
        self.tmp.cleanup()

    def test_reuses_a_complete_copy_without_asking(self):
        dest = self.dir / "t.tif"
        dest.write_bytes(b"abc")
        dem.session = FakeSession(b"xyz")
        got = dem.download("http://example/t.tif", dest, size=3)
        self.assertEqual(got, dest)
        self.assertEqual(dest.read_bytes(), b"abc")
        self.assertEqual(dem.session.calls, [], "the network was touched for a cached tile")

    def test_a_size_mismatch_refetches(self):
        dest = self.dir / "t.tif"
        dest.write_bytes(b"ab")
        dem.session = FakeSession(b"xyz")
        dem.download("http://example/t.tif", dest, size=3)
        self.assertEqual(dest.read_bytes(), b"xyz")

    def test_the_temp_is_private_and_published_atomically(self):
        dest = self.dir / "t.tif"
        seen: set[str] = set()

        def watch():
            seen.update(p.name for p in self.dir.iterdir())

        dem.session = FakeSession(b"hello world", on_chunk=watch)
        dem.download("http://example/t.tif", dest, size=11)
        self.assertEqual(dest.read_bytes(), b"hello world")
        self.assertNotIn("t.tif.part", seen, "a shared dest.part is the corruption trap")
        self.assertTrue(any(n.startswith("t.tif.") and n.endswith(".part") for n in seen), "no unique temp was used")
        self.assertFalse(list(self.dir.glob("*.part")), "a partial was left behind")

    def test_two_writers_on_one_dest_do_not_corrupt(self):
        dest = self.dir / "t.tif"
        body = bytes(range(256)) * 4096  # exactly one 1 MiB chunk
        barrier = threading.Barrier(2)

        def chunk():  # hold both writers inside their own temp at the same instant
            try:
                barrier.wait(timeout=5)
            except threading.BrokenBarrierError:
                pass

        dem.session = FakeSession(body, on_chunk=chunk)
        errs: list[Exception] = []

        def work():
            try:
                dem.download("http://example/t.tif", dest, size=len(body))
            except Exception as exc:  # noqa: BLE001
                errs.append(exc)

        ts = [threading.Thread(target=work) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errs, [])
        self.assertEqual(dest.read_bytes(), body)
        self.assertFalse(list(self.dir.glob("*.part")))


class DedupeTest(unittest.TestCase):
    def item(self, date: str, title: str) -> dict:
        return {"publicationDate": date, "title": title, "downloadURL": "https://x/" + title.replace(" ", "_") + ".tif"}

    def test_keeps_only_the_newest_vintage_per_tile(self):
        # the real dc-metro-take-2 overlap, oldest first as discover_1m leaves it
        titles = [
            ("2020-02-20", "USGS one meter x31y432 VA Fairfax County 2018"),
            ("2020-03-30", "USGS one meter x31y432 MD VA Sandy NCR 2014"),
            ("2024-11-16", "USGS 1 Meter 18 x31y432 VA_NorthernVA_B22"),
            ("2026-04-04", "USGS 1 Meter 18 x31y432 MD_Central_Processing_D24"),
            ("2024-11-16", "USGS 1 Meter 18 x31y431 VA_NorthernVA_B22"),
            ("2020-03-30", "USGS one meter x31y431 MD VA Sandy NCR 2014"),
        ]
        items = sorted((self.item(d, t) for d, t in titles), key=lambda it: it["publicationDate"])
        kept = dem._newest_per_tile(items)
        self.assertEqual([dem._tile_of(k) for k in kept], [(31, 431), (31, 432)])
        by = {dem._tile_of(k): k for k in kept}
        self.assertIn("Central_Processing_D24", by[(31, 432)]["title"], "the newest vintage should win the tile")
        self.assertIn("NorthernVA_B22", by[(31, 431)]["title"])

    def test_tile_id_from_the_url_when_the_title_is_bare(self):
        self.assertEqual(dem._tile_of({"title": "x9y8", "downloadURL": ""}), (9, 8))

    def test_an_unnamed_item_is_kept_not_guessed_away(self):
        items = [self.item("2020-01-01", "weird product with no tile")]
        self.assertEqual(dem._newest_per_tile(items), items)


class SweepTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_old_partials_go_and_young_ones_stay(self):
        nested = self.dir / "sub"
        nested.mkdir()
        old = nested / "a.tif.1.deadbeef.part"
        old.write_bytes(b"x")
        young = self.dir / "b.tif.2.cafef00d.part"
        young.write_bytes(b"y")
        now = time.time()
        os.utime(old, (now - 10 * 3600, now - 10 * 3600))
        self.assertEqual(dem.sweep_partials(self.dir, max_age_s=3600), 1)
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())

    def test_a_finished_file_is_never_touched(self):
        good = self.dir / "t.tif.3.01234567.part"  # only a partial name is swept; a real tile has no .part
        good.write_bytes(b"x")
        good.rename(self.dir / "t.tif")
        os.utime(self.dir / "t.tif", (0, 0))
        self.assertEqual(dem.sweep_partials(self.dir, max_age_s=1), 0)
        self.assertTrue((self.dir / "t.tif").exists())


if __name__ == "__main__":
    unittest.main()
