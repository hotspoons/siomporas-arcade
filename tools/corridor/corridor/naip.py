"""Imagery on the site's UTM lattice: NAIP at 30 cm in the United States, Sentinel-2 at 10 m elsewhere.

Ported from trailworks `fetch_naip_rgb`, with two changes: the resolution is the service's native
0.3 m rather than 1 m (USGSNAIPPlus reports pixelSize 0.3 — the current NAIP cycle is 60 cm and
some states 30 cm, so 0.3 is at or past the source and never below it), and `bandIds=0,1,2` is
passed explicitly because the service carries a fourth NIR band and we want natural colour, not
whatever the default rendering rule feels like today.

exportImage caps at 4000 px a side, so the corridor is fetched as 1200 m tiles and stitched. The
response JPEGs are cached; a re-run never leaves the machine.

OUTSIDE THE UNITED STATES there is no NAIP, and the way the service says so is the trap — see
`covered()`. The fallback is Sentinel-2 L2A, which is global, free, anonymous and 10 m. That is
33x coarser than NAIP and it is the honest cost of baking abroad: at 10 m a two-lane road is one
pixel wide, so road SURFACE appearance has to come from the OSM tags and our own materials rather
than from the photograph. The imagery is then landscape context, which is what it mostly is anyway
at any distance from the car.
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

# Sentinel-2 L2A, through the same STAC API `dem.py` uses for Copernicus. `TCI` — the "visual"
# asset — is a ready-made 3-band 8-bit true-colour COG at 10 m, so there is no band maths, no
# reflectance stretch and no decision for us to get wrong; gdalwarp reads it over /vsicurl.
STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search"
S2_COLLECTION = "sentinel-2-l2a"
S2_RES = 10.0
# Two months back is enough to find a clear scene almost anywhere without reaching into a
# different season, which would show snow on a pass that is dry today.
S2_LOOKBACK_DAYS = 60
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


def covered(frame: Frame, bbox: tuple[float, float, float, float]) -> bool:
    """
    Does NAIP actually have imagery here?

    NOT A STATUS-CODE CHECK, because the service does not fail outside its coverage — it answers
    **HTTP 200 with a valid, entirely black JPEG**. Measured with one 32x32 export from each of two
    places on 2026-09-22:

        Stelvio pass (Italy)   200  image/jpeg  659 B   1 distinct colour,   0% non-zero
        Crofton (Maryland)     200  image/jpeg  905 B   390 distinct colours, 100% non-zero

    This is the same shape as the Overpass silent empty: a well-formed success carrying nothing.
    So the probe asserts CONTENT — more than one colour — and the control above is what proves the
    assertion can tell the two apart. One 905-byte request decides it.
    """
    xmin, ymin, xmax, ymax = bbox
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    try:
        r = _get_with_retry(
            SERVICE,
            params={
                "bbox": f"{cx - 320},{cy - 320},{cx + 320},{cy + 320}", "bboxSR": frame.epsg, "imageSR": frame.epsg,
                "size": "32,32", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image",
            },
            timeout=120,
            tries=2,
        )
        if not r.headers.get("content-type", "").startswith("image"):
            return False
        probe = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))
        return len(np.unique(probe.reshape(-1, 3), axis=0)) > 1
    except Exception as exc:
        print(f"  naip    coverage probe failed ({exc}); assuming no NAIP here", flush=True)
        return False


def fetch_sentinel2(frame: Frame, bbox: tuple[float, float, float, float], out: Path, res: float = S2_RES) -> dict:
    """
    The global fallback: the least-cloudy recent Sentinel-2 scene, warped onto the site lattice.

    `res` is the LATTICE, not the source. Sentinel-2 is 10 m whatever we ask for; a network site
    writes `naip_1m.tif` at 1 m and several readers key off that name and spacing, so it is
    upsampled rather than surprising them. `res_m` records the grid and `source_res_m` the truth.
    """
    import datetime as _dt
    import os
    import subprocess

    from . import dem  # VSICURL_ENV lives there; one definition of how we read a remote COG

    w, s, e, n = frame.bbox_wgs(*bbox)
    # RFC3339, with the time — the API rejects a bare `2026-07-24/..` with
    # "datetime value is invalid, does not match RFC3339 format", which is a 400 rather than an
    # empty result, so at least it fails loudly.
    since = (_dt.datetime.now(_dt.UTC) - _dt.timedelta(days=S2_LOOKBACK_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = session.post(
        STAC_SEARCH,
        json={
            "collections": [S2_COLLECTION],
            "bbox": [w, s, e, n],
            "datetime": f"{since}/..",
            "query": {"eo:cloud_cover": {"lt": 20}},
            "sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}],
            "limit": 5,
        },
        timeout=120,
    )
    r.raise_for_status()
    feats = r.json().get("features", [])
    if not feats:
        raise RuntimeError(f"no Sentinel-2 scene under 20% cloud since {since} for {w:.4f},{s:.4f},{e:.4f},{n:.4f}")
    scene = feats[0]
    href = scene["assets"]["visual"]["href"]
    props = scene["properties"]
    print(
        f"  naip    no NAIP here; Sentinel-2 {scene['id']} ({props['datetime'][:10]}, "
        f"{props.get('eo:cloud_cover', 0):.1f}% cloud, {S2_RES:g} m source on a {res:g} m lattice)",
        flush=True,
    )
    xmin, ymin, xmax, ymax = bbox
    subprocess.run(
        [
            "gdalwarp", "-q", "-overwrite", "-t_srs", frame.crs,
            "-te", str(xmin), str(ymin), str(xmax), str(ymax), "-tr", str(res), str(res),
            "-r", "cubic", "-ot", "Byte",
            "-co", "COMPRESS=JPEG", "-co", "PHOTOMETRIC=YCBCR", "-co", "TILED=YES",
            "/vsicurl/" + href, str(out),
        ],
        check=True,
        env={**os.environ, **dem.VSICURL_ENV},
    )
    return {
        "file": out.name,
        "res_m": res,
        "source_res_m": S2_RES,
        "source": "Sentinel-2 L2A (TCI)",
        "scene": scene["id"],
        "date": props["datetime"][:10],
        "cloud_pct": props.get("eo:cloud_cover"),
    }


def fetch_naip(frame: Frame, bbox: tuple[float, float, float, float], out: Path, cache: Path) -> dict:
    if out.exists():
        return {"file": out.name, "cached": True}
    if not covered(frame, bbox):
        return fetch_sentinel2(frame, bbox, out)
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
