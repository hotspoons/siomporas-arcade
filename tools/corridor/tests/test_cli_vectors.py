"""`corridor vectors` — split the heavy spatial arrays out of an already-exported manifest.

A world exported before vector tiling existed still carries its footprints and street furniture
inline; `cmd_vectors` rewrites the manifest to the tiled shape so the viewer stops parsing them at
load, without a rebake. This pins the outcomes: it tiles a big manifest, it writes the same schema
`export_site` writes, it upgrades a world an earlier buildings-only backfill tiled by reading the
footprints back out of the tiles, it leaves a small manifest inline, and it is a no-op on one
already on the current schema.
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

    def test_tiles_furniture_and_upgrades_a_buildings_only_backfill(self):
        web = self._data / "sites" / "old" / "web"
        web.mkdir(parents=True)
        # an earlier backfill: footprints in a tile, the furniture still inline, no `cells` schema
        (web / "vt" / "0").mkdir(parents=True)
        (web / "vt" / "0" / "0_0.json").write_text(json.dumps({"buildings": [{"ring": [[1.0, 1.0]], "height_m": 4.0}, {"ring": [[1.5, 1.5]], "height_m": 3.0}]}))
        (web / "manifest.json").write_text(json.dumps({
            "slug": "old", "buildings": [], "vt": {"size_m": 1000, "dir": "vt/0", "buildings": [{"x": 0, "y": 0, "n": 2}], "count": 2},
            "sidewalks": [{"kind": "sidewalk", "coords": [[2.0, 2.0, 0.0], [3.0, 2.0, 0.0]]}],
            "signals": {"masts": [{"x": 5.0, "y": 5.0}], "signs": [], "bars": []},
        }))
        cli.cmd_vectors(argparse.Namespace(slug="old"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertEqual(out["buildings"], [])
        self.assertEqual(out["sidewalks"], [])
        self.assertIsNone(out["signals"])
        cell = json.loads((web / "vt" / "0" / "0_0.json").read_text())
        self.assertEqual(len(cell["buildings"]), 2)  # read back from the old tile
        self.assertEqual(len(cell["sidewalks"]), 1)
        self.assertEqual(len(cell["signals"]["masts"]), 1)
        self.assertEqual(out["vt"]["counts"]["buildings"], 2)

    def test_leaves_a_small_manifest_inline(self):
        web = self._site("small", [_footprint(100, 100)])
        cli.cmd_vectors(argparse.Namespace(slug="small"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertNotIn("vt", out)
        self.assertEqual(len(out["buildings"]), 1)

    def test_is_a_noop_when_already_on_the_cells_schema(self):
        web = self._site("done", [])
        (web / "manifest.json").write_text(json.dumps({"slug": "done", "buildings": [], "vt": {"cells": [{"x": 0, "y": 0}]}}))
        cli.cmd_vectors(argparse.Namespace(slug="done"))
        out = json.loads((web / "manifest.json").read_text())
        self.assertEqual(out["vt"], {"cells": [{"x": 0, "y": 0}]})


if __name__ == "__main__":
    unittest.main()
