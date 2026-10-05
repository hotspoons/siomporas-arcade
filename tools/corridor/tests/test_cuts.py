"""cuts.measure_network: the region-wide rewrite must not change a single face.

dc-metro-take-2 spent 8 h 22 m in `cuts` because `measure` re-read and re-parsed `osm.geojson`
once per road and rewrote `cuts.json` on every call. The fix loads the shared context once and fans
the per-road walk across the fork pool (cuts.py docstring). These tests pin the two things that can
go wrong in that refactor: the detection still finds a face, and the forked path returns exactly
what the serial path does.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402

from corridor import cuts  # noqa: E402

H = W = 200
#: terrain rises 0.7 m per metre for every y above 100 — a 30 m wall beside a road at y=100 and
#: another at y=150, which both `measure('left')` transects climb.
RAMP = 0.7
DELTA = 0.7  # slope of the 5 m window, above SLOPE_MIN = 0.6


def _write_dtm(path: Path) -> None:
    z = np.zeros((H, W), dtype="float32")
    for r in range(H):
        yc = (H - (r + 0.5))  # transform from_origin(0, 200, 1, 1): row r centre is y=199.5-r
        if yc > 100.0:
            z[r, :] = (yc - 100.0) * RAMP
    with rasterio.open(path, "w", driver="GTiff", height=H, width=W, count=1, dtype="float32",
                       crs="EPSG:32618", transform=from_origin(0, H, 1, 1)) as ds:
        ds.write(z, 1)


def _profile(road_z: float) -> dict:
    s = np.arange(0.0, 180.0, cuts.STEP_M)
    return {"step_m": cuts.STEP_M, "s": [round(float(v), 1) for v in s],
            "road_z": [road_z] * len(s)}


def _make_site(root: Path, with_sibling: bool) -> Path:
    site = root / "site"
    (site / "lidar").mkdir(parents=True)
    _write_dtm(site / "lidar" / "dtm.tif")
    (site / "site.json").write_text(json.dumps({"slug": "t", "lon": -76.6, "lat": 39.0,
                                                "frame": {"epsg": 32618, "origin": [0.0, 0.0]},
                                                "bbox_utm": [0.0, 0.0, 200.0, 200.0]}))
    (site / "profile.json").write_text(json.dumps(_profile(0.0)))
    siblings = []
    branches = []
    if with_sibling:
        siblings.append({"id": 42, "ident": "Side Rd",
                         "geometry": {"type": "LineString", "coordinates": [[10, 150], [190, 150]]}})
        branches.append({"id": 42, "profile": _profile(35.0)})
    (site / "spine_utm.json").write_text(json.dumps({
        "network": True, "coords": [[10, 100], [190, 100]],
        "primary": {"ident": "Test Rd"}, "siblings": siblings}))
    (site / "branches.json").write_text(json.dumps({"frame": "enu", "branches": branches}))
    return site


class MeasureNetworkTest(unittest.TestCase):
    def _run(self, site: Path, jobs: int) -> dict:
        old = os.environ.get("CORRIDOR_TILE_JOBS")
        os.environ["CORRIDOR_TILE_JOBS"] = str(jobs)
        try:
            cuts._CUTS_CTX = {}
            return cuts.measure_network(site)
        finally:
            if old is None:
                os.environ.pop("CORRIDOR_TILE_JOBS", None)
            else:
                os.environ["CORRIDOR_TILE_JOBS"] = old

    def test_finds_a_face_beside_the_primary(self):
        with tempfile.TemporaryDirectory() as d:
            site = _make_site(Path(d), with_sibling=False)
            out = self._run(site, jobs=1)
            self.assertIsNotNone(out)
            self.assertGreaterEqual(out["summary"]["faces"], 1)
            face = out["faces"][0]
            self.assertEqual(face["road"], "Test Rd")  # every face names its road
            self.assertEqual(face["side"], "left")     # travel +x, terrain rises on +y (left)
            self.assertTrue((site / "cuts.json").exists())

    def test_pool_matches_serial_face_for_face(self):
        with tempfile.TemporaryDirectory() as d:
            site = _make_site(Path(d), with_sibling=True)
            serial = self._run(site, jobs=1)
            pooled = self._run(site, jobs=2)
            self.assertEqual(serial["summary"], pooled["summary"])
            self.assertEqual([f["id"] for f in serial["faces"]], [f["id"] for f in pooled["faces"]])
            self.assertEqual({f["road"] for f in pooled["faces"]}, {"Test Rd", "Side Rd"})

    def test_shared_context_does_not_reparse_osm_per_road(self):
        # The regression guard: `_load_shared` reads osm.geojson once; `_faces_for` must not read
        # any file. Count opens by replacing Path.read_text with a counter around the walk only.
        with tempfile.TemporaryDirectory() as d:
            site = _make_site(Path(d), with_sibling=True)
            cuts._CUTS_CTX = {}
            ctx = cuts._load_shared(site)
            cuts._CUTS_CTX = {**ctx, "jobs": []}
            ctx["jobs"] = [{"prefix": "", "ident": "Test Rd", "line": None, "prof": None}]
            reads = {"n": 0}
            from corridor.water import _Heights

            real = Path.read_text

            def counted(self, *a, **k):
                reads["n"] += 1
                return real(self, *a, **k)

            Path.read_text = counted
            try:
                hz = _Heights(site)
                try:
                    cuts._faces_for(ctx, None, None, "", hz)
                finally:
                    hz.close()
            finally:
                Path.read_text = real
            self.assertEqual(reads["n"], 0, "the per-road walk still reads files")


if __name__ == "__main__":
    unittest.main()
