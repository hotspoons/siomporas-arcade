"""A cached raster is reused only when it covers the site (rastercache.py)."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

from corridor import rastercache

CRS = "EPSG:32618"


def write(path: Path, xmin: float, ymax: float, w: int, h: int, res: float = 1.0, crs: str = CRS) -> None:
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32", crs=crs, transform=from_origin(xmin, ymax, res, res), nodata=-9999) as ds:
        ds.write(np.zeros((h, w), dtype=np.float32), 1)


class Covers(unittest.TestCase):
    def test_a_raster_over_the_bbox_is_reused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dem_1m.tif"
            write(p, 1000, 2000, 500, 500)  # 1000-1500 x 1500-2000
            self.assertTrue(rastercache.covers(p, CRS, (1100, 1600, 1400, 1900)))
            self.assertTrue(rastercache.reuse(p, CRS, (1000, 1500, 1500, 2000), "dem"))
            self.assertTrue(p.exists())

    def test_a_smaller_raster_is_dropped_and_refetched(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dem_1m.tif"
            write(p, 1000, 2000, 500, 500)
            # the Crofton case: the site grew past the cached DEM
            self.assertFalse(rastercache.covers(p, CRS, (500, 1000, 2000, 2500)))
            self.assertFalse(rastercache.reuse(p, CRS, (500, 1000, 2000, 2500), "dem"))
            self.assertFalse(p.exists(), "the stale raster is removed so the fetch writes a fresh one")

    def test_a_raster_in_another_frame_is_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dem_1m.tif"
            write(p, 1000, 2000, 500, 500, crs="EPSG:32617")
            self.assertFalse(rastercache.covers(p, CRS, (1100, 1600, 1400, 1900)))

    def test_a_missing_or_unreadable_file_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "dem_1m.tif"
            self.assertFalse(rastercache.reuse(p, CRS, (0, 0, 1, 1), "dem"))
            p.write_bytes(b"not a tiff")
            self.assertFalse(rastercache.reuse(p, CRS, (0, 0, 1, 1), "dem"))
            self.assertFalse(p.exists())


if __name__ == "__main__":
    unittest.main()
