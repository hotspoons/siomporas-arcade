"""NAIP imagery at 30 cm on the site's UTM lattice.

Ported from trailworks `fetch_naip_rgb`, with two changes: the resolution is the service's native
0.3 m rather than 1 m (USGSNAIPPlus reports pixelSize 0.3 — the current NAIP cycle is 60 cm and
some states 30 cm, so 0.3 is at or past the source and never below it), and `bandIds=0,1,2` is
passed explicitly because the service carries a fourth NIR band and we want natural colour, not
whatever the default rendering rule feels like today.

exportImage caps at 4000 px a side, so the corridor is fetched as 1200 m tiles and stitched. The
response JPEGs are cached; a re-run never leaves the machine.
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_origin

from .geo import Frame

SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"
RES = 0.3
TILE_PX = 4000
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


def fetch_naip(frame: Frame, bbox: tuple[float, float, float, float], out: Path, cache: Path) -> dict:
    if out.exists():
        return {"file": out.name, "cached": True}
    xmin, ymin, xmax, ymax = bbox
    width = int(round((xmax - xmin) / RES))
    height = int(round((ymax - ymin) / RES))
    mosaic = np.zeros((3, height, width), dtype=np.uint8)
    tiles = [(r0, c0) for r0 in range(0, height, TILE_PX) for c0 in range(0, width, TILE_PX)]
    for i, (r0, c0) in enumerate(tiles, 1):
        tw, th = min(TILE_PX, width - c0), min(TILE_PX, height - r0)
        bx0, by1 = xmin + c0 * RES, ymax - r0 * RES
        hit = cache / "naip" / f"{frame.epsg}_{bx0:.1f}_{by1:.1f}_{tw}x{th}_{RES:g}.jpg"
        if hit.exists():
            raw = hit.read_bytes()
        else:
            r = _get_with_retry(
                SERVICE,
                params={
                    "bbox": f"{bx0},{by1 - th * RES},{bx0 + tw * RES},{by1}", "bboxSR": frame.epsg, "imageSR": frame.epsg,
                    "size": f"{tw},{th}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image",
                },
                timeout=300,
            )
            r.raise_for_status()
            if not r.headers.get("content-type", "").startswith("image"):
                raise RuntimeError(f"NAIP exportImage returned {r.headers.get('content-type')}: {r.text[:200]}")
            raw = r.content
            hit.parent.mkdir(parents=True, exist_ok=True)
            hit.write_bytes(raw)
        tile = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"))
        mosaic[:, r0 : r0 + th, c0 : c0 + tw] = np.moveaxis(tile, -1, 0)
        print(f"  naip    tile {i}/{len(tiles)}", flush=True)
    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=frame.crs,
        transform=from_origin(xmin, ymax, RES, RES), compress="jpeg", photometric="ycbcr", tiled=True, jpeg_quality=88,
    ) as dst:
        dst.write(mosaic)
    return {"file": out.name, "res_m": RES, "size": [width, height]}
