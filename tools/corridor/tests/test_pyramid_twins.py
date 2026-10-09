"""pyramid.encode_twins: the `.ktx2` beside every pyramid tile's `.jpg`, and the flag that says so.

The viewer prefers the twin only when the manifest's `layers.pyramid.texture_ktx2` is set, and the
bake sets it only when EVERY jpg under `web/pyr` has one — a viewer must never have to ask per
tile. These pin that contract with a stand-in encoder (`CORRIDOR_KTX` pointing at a script that
copies its input to its output), because the real `ktx` binary is not in the repo.

    tools/corridor/.venv/bin/python -m pytest tools/corridor/tests/test_pyramid_twins.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import ktx2, pyramid  # noqa: E402

# copies its input to its output and leaves its argv beside it, so a test can read what it was asked
STUB = ("#!/usr/bin/env python3\nimport shutil, sys\nshutil.copy(sys.argv[-2], sys.argv[-1])\n"
        "open(sys.argv[-1] + '.argv', 'w').write(' '.join(sys.argv[1:]))\n")


class TwinsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.web = Path(self.tmp.name) / "web"
        (self.web / "pyr" / "14").mkdir(parents=True)
        (self.web / "pyr" / "13").mkdir(parents=True)
        for name in ("14/1_1", "14/1_2", "13/0_0"):
            (self.web / "pyr" / f"{name}.jpg").write_bytes(b"\xff\xd8 not really a jpeg")
        self.stub = Path(self.tmp.name) / "ktxstub"  # not `ktx`: the no-encoder test puts this dir on PATH
        self.stub.write_text(STUB)
        self.stub.chmod(0o755)
        self.env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env)
        self.tmp.cleanup()

    def test_every_jpg_gets_a_twin_and_the_flag(self):
        os.environ["CORRIDOR_KTX"] = str(self.stub)
        out: dict = {"texture": "jpg"}
        kk = pyramid.encode_twins(self.web, out)
        self.assertEqual(kk["ok"], 3)
        self.assertEqual(out.get("texture_ktx2"), "ktx2")
        for name in ("14/1_1", "14/1_2", "13/0_0"):
            self.assertTrue((self.web / "pyr" / f"{name}.ktx2").exists(), name)
        # stored bottom-up, or it draws mirrored under three's flipY jpg (ktx2.py's docstring)
        argv = (self.web / "pyr" / "14" / "1_1.ktx2.argv").read_text()
        self.assertIn("--convert-texcoord-origin bottom-left", argv)
        self.assertIn("--generate-mipmap", argv)
        # a second run finds them current and keeps the flag
        kk = pyramid.encode_twins(self.web, out)
        self.assertEqual((kk["ok"], kk["skip"]), (0, 3))
        self.assertEqual(out.get("texture_ktx2"), "ktx2")

    def test_no_encoder_means_no_flag_and_no_twins(self):
        os.environ["CORRIDOR_KTX"] = str(Path(self.tmp.name) / "absent")
        os.environ["PATH"] = self.tmp.name  # no `ktx` on the path either (the stub is `ktxstub`)
        # the repo-local .bin is a symlink farm on some checkouts: only the env and PATH count here
        orig = ktx2.HERE
        try:
            ktx2.HERE = Path(self.tmp.name)
            out: dict = {"texture": "jpg"}
            kk = pyramid.encode_twins(self.web, out)
        finally:
            ktx2.HERE = orig
        self.assertEqual(kk.get("status"), "no encoder")
        self.assertNotIn("texture_ktx2", out)
        self.assertEqual(list((self.web / "pyr").rglob("*.ktx2")), [])

    def test_one_failed_tile_withholds_the_flag(self):
        # an encoder that refuses one tile: the viewer would 404 on that twin, so the bake keeps
        # the jpg path for the whole layer rather than make the viewer ask per tile
        picky = Path(self.tmp.name) / "picky"
        picky.write_text("#!/usr/bin/env python3\nimport shutil, sys\nsys.exit(1) if '1_2' in sys.argv[-2] else shutil.copy(sys.argv[-2], sys.argv[-1])\n")
        picky.chmod(0o755)
        os.environ["CORRIDOR_KTX"] = str(picky)
        out: dict = {"texture": "jpg", "texture_ktx2": "ktx2"}  # a stale flag from an earlier bake
        kk = pyramid.encode_twins(self.web, out)
        self.assertEqual(kk["fail"], 1)
        self.assertNotIn("texture_ktx2", out)
        self.assertFalse((self.web / "pyr" / "14" / "1_2.ktx2").exists())


if __name__ == "__main__":
    unittest.main()
