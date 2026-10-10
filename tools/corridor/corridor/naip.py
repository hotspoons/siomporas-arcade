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
import os
import threading
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_origin

from . import BakeFault
from .geo import Frame
from . import rastercache

SERVICE = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"
RES = 0.3
TILE_PX = 4000
#: A NAIP hole comes back through a JPEG-compressed shard GeoTIFF, so "no imagery" decodes to a few
#: counts rather than exact zero. NAIP is flown leaf-on in daylight, so real ground is never this
#: dark on all three channels at once. Shared by the fetch-side guard (`network_tiles.naip_tiled`)
#: and the pyramid bake's blank test (`pyramid.naip_blank`) so both agree on what a hole is.
NAIP_BLANK_MAX = 2

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


def _get_with_retry(url: str, params: dict, timeout: int, tries: int = 9, session: requests.Session | None = None):
    """USGS's ArcGIS image services answer 502/503/504 under load. Back off — PATIENTLY.

    They usually recover in seconds, but on 2026-10-10 the NAIP ImageServer answered 504 for about
    four minutes, and the old five tries (two minutes in all) killed one shard of a 25-shard
    dc-metro bake and with it the run. Nine tries backing off 10, 20, 40, then 60 s gives an outage
    about seven minutes to pass before this gives up.
    """
    import time

    session = session or globals()["session"]
    last = None
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code < 500:
                return r
            last = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:
            last = exc
        if attempt + 1 < tries:
            time.sleep(min(60, 10 * 2**attempt))
    raise RuntimeError(f"{url}: {last}")


#: One `requests.Session` per worker thread. A Session owns a urllib3 connection pool and is not
#: documented thread-safe; sharing the module-level one across the fetch pool invites exactly the
#: kind of intermittent failure that is impossible to reproduce.
_TLS = threading.local()


def _thread_session() -> requests.Session:
    s = getattr(_TLS, "session", None)
    if s is None:
        s = requests.Session()
        _TLS.session = s
    return s


def _fetch_one(hit: Path, params: dict, timeout: int = 300) -> bool:
    """Fetch one service tile into `hit` (atomic), returning False if it was already cached."""
    if hit.exists():
        return False
    r = _get_with_retry(SERVICE, params=params, timeout=timeout, session=_thread_session())
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image"):
        raise RuntimeError(f"NAIP exportImage returned {r.headers.get('content-type')}: {r.text[:200]}")
    hit.parent.mkdir(parents=True, exist_ok=True)
    # Private temp + os.replace: several shards may race the same cache key, and the RWX cache is
    # lock-free by design (a published entry is immutable). A half-written JPEG must never publish.
    tmp = hit.with_name(f"{hit.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    tmp.write_bytes(r.content)
    os.replace(tmp, hit)
    return True


def fetch_tiles_parallel(tasks, jobs: int | None = None, label: str = "naip") -> int:
    """Fetch every missing `(cache_path, params)` concurrently; return how many were downloaded.

    The service averages ~40 s for a 4000x4000 tile and the tiles are independent, so a 44-tile
    shard block spent half an hour mostly waiting on one request at a time. The caller still writes
    the mosaic/site raster serially from the cache afterwards, because one GeoTIFF has one writer.
    `CORRIDOR_NAIP_JOBS` caps the concurrency (default 6) so twelve shards do not open a hundred
    sockets at USGS at once.
    """
    missing = [(h, p) for h, p in tasks if not h.exists()]
    if not missing:
        return 0
    jobs = jobs if jobs is not None else int(os.environ.get("CORRIDOR_NAIP_JOBS", "6") or "6")
    jobs = max(1, min(int(jobs), len(missing)))
    if jobs == 1:
        n = sum(1 for h, p in missing if _fetch_one(h, p))
        print(f"  {label}    fetched {n}/{len(missing)} tiles", flush=True)
        return n
    from concurrent.futures import ThreadPoolExecutor, as_completed

    n = 0
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(_fetch_one, h, p) for h, p in missing]
        for done, fut in enumerate(as_completed(futs), 1):
            n += 1 if fut.result() else 0
            if done % 5 == 0 or done == len(missing):
                print(f"  {label}    fetched {done}/{len(missing)} tiles ({jobs} parallel)", flush=True)
    return n


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
        )
    except Exception as exc:
        # NOT "no NAIP here". On 2026-10-10 a four-minute 504 from the ImageServer was read as an
        # answer, and the shard swapped 0.6 m aerial photography for 10 m Sentinel-2 with nothing
        # failing — the silent-success family again (an outage is not an answer). A probe that
        # could not ask stops the bake; the run is retried when the service is back.
        raise BakeFault(f"naip coverage probe could not reach the service, so this bake cannot tell whether NAIP covers it: {exc}") from exc
    if not r.headers.get("content-type", "").startswith("image"):
        # an ArcGIS error document comes back as 200 JSON: also not an answer about coverage
        raise BakeFault(f"naip coverage probe got {r.headers.get('content-type', 'no content type')} instead of an image: {r.text[:200]!r}")
    probe = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"))
    return len(np.unique(probe.reshape(-1, 3), axis=0)) > 1


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
    if rastercache.reuse(out, frame.crs, bbox, "naip"):
        return {"file": out.name, "cached": True}
    if not covered(frame, bbox):
        return fetch_sentinel2(frame, bbox, out)
    xmin, ymin, xmax, ymax = bbox
    width = int(round((xmax - xmin) / RES))
    height = int(round((ymax - ymin) / RES))
    mosaic = np.zeros((3, height, width), dtype=np.uint8)
    plan = []  # (r0, c0, tw, th, cache_path, params)
    for r0 in range(0, height, TILE_PX):
        for c0 in range(0, width, TILE_PX):
            tw, th = min(TILE_PX, width - c0), min(TILE_PX, height - r0)
            bx0, by1 = xmin + c0 * RES, ymax - r0 * RES
            hit = cache / "naip" / f"{frame.epsg}_{bx0:.1f}_{by1:.1f}_{tw}x{th}_{RES:g}.jpg"
            plan.append((r0, c0, tw, th, hit, {
                "bbox": f"{bx0},{by1 - th * RES},{bx0 + tw * RES},{by1}", "bboxSR": frame.epsg, "imageSR": frame.epsg,
                "size": f"{tw},{th}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image",
            }))
    fetch_tiles_parallel([(h, p) for _, _, _, _, h, p in plan])
    for i, (r0, c0, tw, th, hit, _params) in enumerate(plan, 1):
        tile = np.asarray(Image.open(io.BytesIO(hit.read_bytes())).convert("RGB"))
        mosaic[:, r0 : r0 + th, c0 : c0 + tw] = np.moveaxis(tile, -1, 0)
        print(f"  naip    tile {i}/{len(plan)}", flush=True)
    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=frame.crs,
        transform=from_origin(xmin, ymax, RES, RES), compress="jpeg", photometric="ycbcr", tiled=True, jpeg_quality=88,
    ) as dst:
        dst.write(mosaic)
    return {"file": out.name, "res_m": RES, "size": [width, height]}
