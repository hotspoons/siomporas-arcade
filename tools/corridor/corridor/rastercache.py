"""Is a cached raster still the raster this bake needs?

Rich, 2026-09-30, on the Crofton world re-baked on the cluster with a bigger radius and a new
centre: "it looks like the lidar got messed up and parts of the terrain cover the road". The lidar
was fine. `dem_1m.tif` from an EARLIER bake of the same slug was sitting in the site directory,
`fetch_dem` saw the file and returned `{"cached": True}` without looking at it, and the terrain
tiles were cut from a DEM that covered a third of the new site: 79 of 158 tiles were solid
nodata (-9999, a flat floor ten kilometres down) and the tiles at the old DEM's edge copied its
last row outward as a wall 10-29 m over the road. `horizon_30m.tif` and `naip_1m.tif` had been
reused the same way.

A cached raster is reusable when it is in the frame's CRS and its bounds contain what is asked
for. Anything else is deleted and fetched again, and the log says so.
"""
from __future__ import annotations

from pathlib import Path


def covers(path: Path, crs: str, bbox: tuple[float, float, float, float], tol_m: float = 0.5) -> bool:
    """True when `path` is a readable raster in `crs` whose bounds contain `bbox` (within `tol_m`)."""
    if not path.exists():
        return False
    try:
        import rasterio
        from rasterio.crs import CRS

        with rasterio.open(path) as ds:
            if ds.crs is None or CRS.from_user_input(crs) != ds.crs:
                return False
            b = ds.bounds
            xmin, ymin, xmax, ymax = bbox
            return b.left <= xmin + tol_m and b.bottom <= ymin + tol_m and b.right >= xmax - tol_m and b.top >= ymax - tol_m
    except Exception:
        return False


def reuse(path: Path, crs: str, bbox: tuple[float, float, float, float], what: str) -> bool:
    """Keep and reuse `path` when it covers the bbox; otherwise remove it and say why. Returns whether to reuse."""
    if not path.exists():
        return False
    if covers(path, crs, bbox):
        return True
    extent = "unreadable"
    try:
        import rasterio

        with rasterio.open(path) as ds:
            b = ds.bounds
            extent = f"{b.left:.0f}-{b.right:.0f} x {b.bottom:.0f}-{b.top:.0f} ({ds.crs})"
    except Exception:
        pass
    print(f"  {what:<7} cached {path.name} covers {extent}; this site needs {bbox[0]:.0f}-{bbox[2]:.0f} x {bbox[1]:.0f}-{bbox[3]:.0f} — fetching again", flush=True)
    path.unlink()
    return False
