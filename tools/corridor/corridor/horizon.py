"""The far terrain: what fills the horizon when you look up from the road.

A corridor is a few hundred metres wide; the thing Rich wants to feel is a piedmont ridge across
the whole windscreen, or Catoctin and South Mountain rising out of the ground ahead. That needs
elevation for tens of kilometres around the site, at a resolution the eye cannot fault from 20 km
away. USGS's seamless 3DEP service renders any bbox on request; 30 m pixels over a 60 km square
is a 2000² float raster, one call, a few MB.

This is the LOD-far layer. The 1 m corridor DEM is LOD-near. The game blends the two: the
corridor's own terrain out to a few hundred metres, then this, then a skybox. Sourced from the
same vertical datum as the corridor DEM (NAVD88 metres) so the seam is a resampling problem, not a
datum problem.

Ported from trailworks `_fetch_10m` (which uses the same service at 10 m for tiles).
"""
from __future__ import annotations

from pathlib import Path

import requests

from .geo import Frame

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
RES = 30.0
session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"


def _get_with_retry(url: str, params: dict, timeout: int, tries: int = 5):
    """USGS's ArcGIS image services answer 502/503 under load and recover in seconds. Back off."""
    import time

    last = None
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code < 500:
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:
            last = exc
        time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def fetch_horizon(frame: Frame, out: Path, cache: Path, radius_m: float = 30000.0) -> dict:
    if out.exists():
        return {"file": out.name, "cached": True}
    ox, oy = frame.origin
    xmin, ymin, xmax, ymax = ox - radius_m, oy - radius_m, ox + radius_m, oy + radius_m
    size = int(round(2 * radius_m / RES))
    if size > 4000:
        raise ValueError("horizon larger than the service's 4000 px cap; raise RES or lower radius")
    r = _get_with_retry(
        SERVICE,
        params={"bbox": f"{xmin},{ymin},{xmax},{ymax}", "bboxSR": frame.epsg, "imageSR": frame.epsg, "size": f"{size},{size}", "format": "tiff", "pixelType": "F32", "noData": "-9999", "interpolation": "RSP_BilinearInterpolation", "f": "image"},
        timeout=300,
    )
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image"):
        raise RuntimeError(f"3DEP exportImage returned {r.headers.get('content-type')}: {r.text[:200]}")
    out.write_bytes(r.content)
    print(f"  horizon {size}x{size} @ {RES:g} m, ±{radius_m / 1000:g} km", flush=True)
    fetch_horizon_naip(frame, out.with_name("horizon_naip_60m.jpg"), radius_m)
    return {"file": out.name, "res_m": RES, "radius_m": radius_m, "size": [size, size], "source": "USGS 3DEP seamless (1/3 arc-second)", "imagery": "horizon_naip_60m.jpg"}


NAIP = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"


def fetch_horizon_naip(frame: Frame, out: Path, radius_m: float, res: float = 60.0) -> None:
    """Colour for the far terrain: NAIP resampled to 60 m over the same square. Without it the
    horizon is a hypsometric ramp, which reads as beige from the road; with it the ridges are the
    forest-green and field-tan they actually are."""
    if out.exists():
        return
    ox, oy = frame.origin
    size = int(round(2 * radius_m / res))
    r = _get_with_retry(
        NAIP,
        params={"bbox": f"{ox - radius_m},{oy - radius_m},{ox + radius_m},{oy + radius_m}", "bboxSR": frame.epsg, "imageSR": frame.epsg, "size": f"{size},{size}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "f": "image"},
        timeout=300,
    )
    r.raise_for_status()
    if r.headers.get("content-type", "").startswith("image"):
        out.write_bytes(r.content)
        print(f"  horizon imagery {size}x{size} @ {res:g} m", flush=True)
