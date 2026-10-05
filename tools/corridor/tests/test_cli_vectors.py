"""`corridor vectors` — split `buildings` out of an already-exported manifest.

A world exported before vector tiling existed still carries its footprints inline; `cmd_vectors`
rewrites the manifest to the tiled shape so the viewer stops parsing them at load, without a
rebake. This pins the four outcomes: it tiles a big manifest, it writes the same index shape
`export_site` writes, it leaves a small manifest inline, and it is a no-op on one already tiled.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import __main__ as cli  # noqa: E402
from corridor import export  # noqa: E402


def _footprint(x: float, y: float) -> dict:
    return {"ring": [[x, y], [x + 10, y], [x + 10, y + 10]], "height_m": 5.0}


class CmdVectorsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._data = Path(self._tmp.name)
        self._old_data = cli.DATA
        cli.DATA = self._data
        self._old_min = export.VECTOR_TILE_MIN
        export.VECTOR_TILE_MIN = 2

    def tearDown(self):
        cli.DATA = self._old_data
        export.VECTOR_TILE_MIN = self._old_min
        self._tmp.cleanup()

    def _site(self, slug: str, buildings: list) -> Path:
        web = self._data / "sites" / slug / "web"
        web.mkdir(parents=True)
        (web / "manifest.json").write_text(json.dumps({"slug": slug, "buildings": buildings}))
        return web

    def test_tiles_a_large_manifest(self):
        web = self._site("big", [_footprint(100, 100), _footprint(1900, 1900), _footprint(-5, -5)])
        cli.cmd_vectors(argparse.Namespace(slug="big"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertEqual(out["buildings"], [])
        self.assertEqual(out["vt"]["size_m"], 1000.0)
        self.assertEqual(out["vt"]["dir"], "vt/0")
        self.assertEqual(out["vt"]["count"], 3)
        self.assertEqual(sorted((t["x"], t["y"], t["n"]) for t in out["vt"]["buildings"]), [(-1, -1, 1), (0, 0, 1), (1, 1, 1)])
        self.assertEqual(len(json.loads((web / "vt" / "0" / "0_0.json").read_text())["buildings"]), 1)

    def test_leaves_a_small_manifest_inline(self):
        web = self._site("small", [_footprint(100, 100)])
        cli.cmd_vectors(argparse.Namespace(slug="small"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertNotIn("vt", out)
        self.assertEqual(len(out["buildings"]), 1)

    def test_is_a_noop_when_already_tiled(self):
        web = self._site("done", [])
        (web / "manifest.json").write_text(json.dumps({"slug": "done", "buildings": [], "vt": {"count": 9}}))
        cli.cmd_vectors(argparse.Namespace(slug="done"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertEqual(out["vt"], {"count": 9})


if __name__ == "__main__":
    unittest.main()
