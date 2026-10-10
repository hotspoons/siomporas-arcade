"""Past the lidar band the canopy is the global model, in the pyramid and the 8 m overview too.

2026-10-10, dc-metro-take-2: Rockville had no trees at all. The point cloud is read only in a band
along the roads and the lidar CHM reads 0 outside it. The flat tiles already filled those cells
from `canopy_global.tif`, but the viewer streams the PYRAMID and falls back to the 8 m OVERVIEW,
and neither did. Plain unittest (the image's CI runs no pytest).
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import network_tiles, pyramid  # noqa: E402
from corridor.geo import Frame  # noqa: E402

CRS = "EPSG:32618"
# 2 km square near Rockville; the lidar covers the WEST half only
X0, Y0 = 315000.0, 4326000.0
SIDE = 2000.0


def write(path: Path, data: np.ndarray, res: float, nodata: float | None = -9999.0) -> None:
    h, w = data.shape
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=CRS, transform=from_origin(X0, Y0 + SIDE, res, res), nodata=nodata) as ds:
        ds.write(data.astype(np.float32), 1)


def site(d: Path) -> Path:
    n = int(SIDE)
    west = np.zeros((n, n), bool)
    west[:, : n // 2] = True
    (d / "lidar").mkdir()
    write(d / "lidar" / "dtm.tif", np.where(west, 50.0, -9999.0), 1.0)
    # the lidar CHM: 0 everywhere it has ground but a 4 m hedge, and 0 where it has nothing
    chm = np.zeros((n, n))
    chm[:, 100:200] = 4.0
    write(d / "lidar" / "chm.tif", chm, 1.0, nodata=None)
    write(d / "canopy_global.tif", np.full((n // 2, n // 2), 12.0), 2.0, nodata=None)
    write(d / "dem_1m.tif", np.full((n, n), 50.0), 1.0)
    (d / "site.json").write_text(json.dumps({"lat": 39.08, "bbox_utm": [X0, Y0, X0 + SIDE, Y0 + SIDE]}))
    return d


class PyramidFill(unittest.TestCase):
    def setUp(self):
        pyramid._OPEN.clear()

    def test_east_of_the_lidar_takes_the_global_canopy_and_the_west_keeps_the_lidar(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = site(Path(tmp))
            frame = Frame(32618, (X0, Y0))
            # a WGS84 tile inside the square, straddling the lidar edge
            (lo0, la0), (lo1, la1) = frame.to_wgs(X0 + 600, Y0 + 600), frame.to_wgs(X0 + 1400, Y0 + 1400)
            w, s, e, n = lo0, la0, lo1, la1
            lidar = pyramid._sample(d / "lidar" / "chm.tif", w, s, e, n, pyramid.TILE_PX, 0.0)
            # the failure this fixes: east of the band the lidar CHM is plain zero
            self.assertLess(float(lidar[:, -50:].max()), 1e-6)
            c, filled = pyramid._fill_canopy(lidar, d / "lidar" / "dtm.tif", d / "canopy_global.tif", w, s, e, n)
            self.assertGreater(filled, pyramid.TILE_PX * pyramid.TILE_PX // 4)
            self.assertAlmostEqual(float(np.median(c[:, -50:])), 12.0, places=3)
            # the west half is lidar ground: its zeros are real "no trees here", not filled
            self.assertLess(float(np.median(c[:, :50])), 1e-6)

    def test_no_lidar_at_all_is_the_global_canopy(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = site(Path(tmp))
            frame = Frame(32618, (X0, Y0))
            (w, s), (e, n) = frame.to_wgs(X0 + 600, Y0 + 600), frame.to_wgs(X0 + 1400, Y0 + 1400)
            c, filled = pyramid._fill_canopy(None, d / "lidar" / "missing.tif", d / "canopy_global.tif", w, s, e, n)
            self.assertEqual(filled, pyramid.TILE_PX * pyramid.TILE_PX)
            self.assertAlmostEqual(float(np.median(c)), 12.0, places=3)


class OverviewFill(unittest.TestCase):
    def test_the_8m_overview_fills_past_the_lidar(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = site(Path(tmp))
            web = d / "web"
            web.mkdir()
            layers = network_tiles.overview(d, web, Frame(32618, (X0, Y0)), [], None)
            self.assertIn("chm", layers)
            from PIL import Image

            c = np.asarray(Image.open(web / layers["chm"]["file"])).astype(np.float32) * layers["chm"]["scale"]
            h, w = c.shape
            self.assertAlmostEqual(float(np.median(c[:, -w // 4 :])), 12.0, places=3)
            self.assertEqual(float(np.median(c[:, : w // 8])), 0.0)


if __name__ == "__main__":
    unittest.main()
