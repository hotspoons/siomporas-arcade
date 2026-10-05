"""USGS 3DEP 1 m DEM for the corridor bbox, warped onto the site's UTM lattice.

Ported from trailworks `pipeline/ingest/sources.py::_fetch_1m` — the TNM API path only. Trailworks
also indexes the whole prd-tnm S3 bucket for API-free discovery; that is worth it when you bake a
state, not for nine corridors. Source GeoTIFFs are 10 km tiles at 300+ MB each and are cached so
neighbouring sites reuse them.

The DEM is the bare earth: bridges and trees are removed by the vendor. That is what makes it the
right reference for lidar.py — anything in the point cloud well above this surface is a structure
or a tree, and the road on a bridge is exactly where DEM and driving surface disagree.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
import uuid
from pathlib import Path

import requests

from .geo import Frame
from . import rastercache

TNM = "https://tnmaccess.nationalmap.gov/api/v1/products"
session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"


# The TNM API and rockyweb are a politeness-limited front for a public S3 bucket, and the bucket is
# the faster, calmer way to get the same bytes (trailworks learned this: pipeline/ingest/tnm_s3.py).
# Staged product URLs map onto the bucket by path; downloads try the bucket first and fall back to
# the catalogued URL when the object is not there (the LPC tree, for one, is not fully mirrored).
ROCKYWEB = "https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/"
PRD_TNM = "https://prd-tnm.s3.amazonaws.com/StagedProducts/"


def s3_mirror(url: str) -> str | None:
    return PRD_TNM + url[len(ROCKYWEB):] if url.startswith(ROCKYWEB) else None


def download(url: str, dest: Path, size: int | None = None) -> Path:
    """Fetch `url` to `dest`, reusing a complete copy and publishing it atomically.

    THE CACHE IS READWRITE-MANY AND EVERY BAKE HOLDS IT AT ONCE, so two jobs can legitimately want
    the same tile. Three rules make that safe WITHOUT a lock:

      * a PRIVATE temp per writer — a shared `dest.part` is the trap: two writers interleave into
        one file and the winner is a corrupt tile whose SIZE still matches, which the reuse check
        below would then trust for ever;
      * ONE atomic rename to publish — a reader sees either no `dest` or the whole of it, never a
        partial, because POSIX `rename` within one filesystem (and CephFS's) is atomic;
      * last-writer-wins is harmless because both writers produce the same bytes for the same URL.

    A `.part` left by a killed job is not ours to delete here (it may belong to a live writer);
    `sweep_partials` collects the abandoned ones at the top of a stage instead.
    """
    if dest.exists() and (size is None or dest.stat().st_size == size):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.part")
    candidates = [u for u in (s3_mirror(url), url) if u]
    last: Exception | None = None
    try:
        for u in candidates:
            for attempt in range(3):
                try:
                    with session.get(u, stream=True, timeout=600) as r:
                        if r.status_code in (403, 404) and u != url:
                            break  # not on the bucket; try the catalogued URL
                        r.raise_for_status()
                        with open(tmp, "wb") as f:
                            for chunk in r.iter_content(1 << 20):
                                f.write(chunk)
                    os.replace(tmp, dest)
                    return dest
                except Exception as exc:  # a dropped connection mid-GB is ordinary; retry the same URL
                    last = exc
                    time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"download failed for {url}: {last}")
    finally:
        tmp.unlink(missing_ok=True)


def sweep_partials(root: Path, max_age_s: float = 6 * 3600) -> int:
    """Delete abandoned `.part` temps under `root`, older than `max_age_s`. Returns how many.

    Each writer's temp is unique now, so a job that dies leaves its own behind and nothing ever
    overwrites it; without this they accumulate for the life of the shared volume. Age is the
    guard: a `.part` younger than the window may belong to a live writer and is left alone.
    """
    if not root.exists():
        return 0
    deadline = time.time() - max_age_s
    killed = 0
    for p in root.rglob("*.part"):
        try:
            if p.stat().st_mtime < deadline:
                p.unlink()
                killed += 1
        except OSError:
            pass  # another job swept it first, or it vanished; either way it is gone
    return killed


ONE_METRE = "Digital Elevation Model (DEM) 1 meter"

_TILE_RE = re.compile(r"x(\d+)y(\d+)", re.I)


def _tile_of(it: dict) -> tuple[int, int] | None:
    """The 10 km `x{n}y{m}` tile an item covers, or None when its name carries none.

    THIS, NOT THE BOUNDING BOX, is the key that identifies one tile across vintages: the boxes of
    two vintages of the same tile disagree in the third decimal (Sandy NCR `38.920` vs Fairfax
    `38.918`), so a bbox key would not merge them. Every vintage names the tile the same way.
    """
    for s in (it.get("title"), it.get("downloadURL")):
        m = _TILE_RE.search(s or "")
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def _newest_per_tile(items: list[dict]) -> list[dict]:
    """One product per tile — the newest — instead of every vintage overlapping the bbox.

    A multi-county bbox returns the same tile two to four times (Fairfax 2018, Sandy NCR 2014,
    NorthernVA B22, Central Processing D24), so the bake downloads and caches several copies of
    identical ground and 495's cached tiles look "not reused". `discover_1m` sorts oldest first so a
    later warp paints on top; keeping the last per tile preserves that — the newest dataset still
    wins — and drops only the copies it would have covered. Items with no tile name are kept, never
    guessed away.
    """
    newest: dict[tuple[int, int], dict] = {}
    unkeyed: list[dict] = []
    for it in items:  # oldest -> newest, so the last write per tile is the newest product
        t = _tile_of(it)
        if t is None:
            unkeyed.append(it)
        else:
            newest[t] = it
    kept = [*newest.values(), *unkeyed]
    kept.sort(key=lambda it: it.get("publicationDate", ""))
    return kept


def discover_1m(w: float, s: float, e: float, n: float, dataset: str = ONE_METRE) -> list[dict]:
    r = session.get(
        TNM,
        params={"datasets": dataset, "bbox": f"{w},{s},{e},{n}", "prodFormats": "GeoTIFF", "outputFormat": "JSON", "max": 100},
        timeout=90,
    )
    r.raise_for_status()
    items = r.json().get("items", [])
    items.sort(key=lambda it: it.get("publicationDate", ""))  # newest LAST: gdalwarp paints later inputs on top
    kept = _newest_per_tile(items)
    if len(kept) < len(items):
        print(f"  dem     {len(items)} TNM products -> {len(kept)} tiles (newest vintage per tile)", flush=True)
    return kept


# 3DEP's 1 m layer is the best bare earth there is and it does not cover everything: the Oregon
# coast at Ecola returns zero items and the site could not bake at all. 1/3 arc-second (~10 m) is
# seamless over CONUS, so fall down the ladder and record what we actually got.
LADDER = [
    (ONE_METRE, 1.0),
    ("National Elevation Dataset (NED) 1/9 arc-second", 3.0),
    ("National Elevation Dataset (NED) 1/3 arc-second", 10.0),
]

# ---------------------------------------------------------------------------------------------
# The rung below the ladder: the rest of the world.
#
# Every dataset above is USGS, which is to say the United States. A site anywhere else fell off the
# bottom with "no DEM coverage from TNM" and could not bake at all, which is why an Italian pass
# was blocked on elevation rather than on roads. Copernicus GLO-30 is global, free, anonymous, and
# served as cloud-optimised GeoTIFFs, so gdalwarp reads it over /vsicurl with no download step and
# the SAME warp that puts a USGS tile on the site lattice puts this there too.
#
# MEASURED, against geocoded positions and published pass heights (2026-09-22):
#
#   Stelvio pass    2757.9 m   published 2757   +0.9
#   Umbrail pass    2500.0 m   published 2501   -1.0
#
# The first attempt at this check sampled three points from memory and got -9999, +837 and -110;
# the DEM was right and my coordinates were wrong. Geocode the control, do not recall it.
#
# TWO THINGS THIS IS NOT, both recorded in the manifest so nothing downstream has to guess:
#
#  * It is 30 m, not 1 m. At 46.5 N a cell is ~21 x 30 m and a Stelvio hairpin is ~20 m across, so
#    the switchbacks that make the pass worth driving are below the sample spacing. The road
#    surface comes from OSM geometry draped on this, so a coarse DEM is a worse LANDSCAPE rather
#    than necessarily a worse road — but it is not 3DEP and the manifest says so.
#  * IT IS A SURFACE MODEL, NOT BARE EARTH. Canopy and buildings are in the elevation. Every other
#    DEM this pipeline has ever seen is a DTM with the trees removed by the vendor, and things
#    downstream assume that — `lidar.check_units` calibrates against it, and the profile's
#    cut-and-fill is ground relative to the road. Through woodland this surface IS the treetops.
#    `surface_model: true` in the manifest is the flag for anything that needs to care.
COP_DEM = "cop-dem-glo-30"
STAC_SEARCH = "https://earth-search.aws.element84.com/v1/search"
# The STAC asset href is an s3:// URI; the same object is public over https, which is what GDAL
# wants and what needs no credentials.
COP_S3 = "s3://copernicus-dem-30m/"
COP_HTTPS = "https://copernicus-dem-30m.s3.amazonaws.com/"


def discover_glo30(w: float, s: float, e: float, n: float) -> list[str]:
    """The GLO-30 COGs covering a bbox, as /vsicurl paths gdalwarp can open directly."""
    r = session.post(
        STAC_SEARCH,
        json={"collections": [COP_DEM], "bbox": [w, s, e, n], "limit": 100},
        timeout=90,
    )
    r.raise_for_status()
    hrefs = []
    for feat in r.json().get("features", []):
        for asset in feat.get("assets", {}).values():
            href = asset.get("href", "")
            if not href.endswith(".tif"):
                continue
            if href.startswith(COP_S3):
                href = COP_HTTPS + href[len(COP_S3):]
            hrefs.append("/vsicurl/" + href)
    return sorted(set(hrefs))


# GDAL reads these over HTTP range requests. Without EMPTY_DIR it tries to list the "directory"
# beside every object, which on S3 is a full bucket listing per tile and takes minutes.
VSICURL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "2",
}


def fetch_dem(frame: Frame, bbox: tuple[float, float, float, float], out: Path, cache: Path) -> dict:
    swept = sweep_partials(cache / "usgs1m")
    if swept:
        print(f"  dem     swept {swept} abandoned .part file(s)", flush=True)
    # only a cached DEM that COVERS this bbox is reused; see rastercache.py for the wall it built
    if rastercache.reuse(out, frame.crs, bbox, "dem"):
        return {"file": out.name, "cached": True}
    w, s, e, n = frame.bbox_wgs(*bbox)
    items, native = [], 1.0
    for dataset, res in LADDER:
        items = discover_1m(w, s, e, n, dataset)
        if items:
            native = res
            if res > 1.0:
                print(f"  dem     no 1 m coverage here; {dataset} (~{res:g} m) upsampled to the 1 m lattice", flush=True)
            break
    xmin, ymin, xmax, ymax = bbox
    warp = [
        "gdalwarp", "-q", "-overwrite", "-t_srs", frame.crs, "-te", str(xmin), str(ymin), str(xmax), str(ymax),
        "-tr", "1", "1", "-r", "bilinear", "-dstnodata", "-9999", "-ot", "Float32",
        "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "PREDICTOR=3",
    ]

    if not items:
        # Off the bottom of the US ladder: the rest of the world. Read straight from the COGs —
        # there is no download step because there is nothing a 30 m tile gains by being on disk,
        # and the warp windows out the few hundred cells this site actually covers.
        cogs = discover_glo30(w, s, e, n)
        if not cogs:
            raise RuntimeError(
                f"no DEM coverage for this bbox: TNM has nothing at 1 m, 1/9 or 1/3 arc-second, "
                f"and Copernicus GLO-30 returned no tiles for {w:.4f},{s:.4f},{e:.4f},{n:.4f}"
            )
        print(f"  dem     outside the USGS ladder; Copernicus GLO-30 (30 m SURFACE model) from {len(cogs)} tile(s)", flush=True)
        subprocess.run([*warp, *cogs, str(out)], check=True, env={**os.environ, **VSICURL_ENV})
        return {
            "file": out.name,
            "native_res_m": 30.0,
            # The flag that matters: this is a DSM. Canopy and buildings are IN it.
            "surface_model": True,
            "source": "Copernicus DEM GLO-30",
            "sources": [{"title": c.rsplit("/", 1)[-1]} for c in cogs],
        }

    tiles = []
    for it in items:
        name = it["downloadURL"].rsplit("/", 1)[1]
        print(f"  dem     {name} ({it.get('sizeInBytes', 0) / 2**20:.0f} MiB, {it.get('publicationDate')})", flush=True)
        tiles.append(download(it["downloadURL"], cache / "usgs1m" / name, it.get("sizeInBytes")))
    subprocess.run([*warp, *[str(t) for t in tiles], str(out)], check=True)
    return {
        "file": out.name,
        "native_res_m": native,
        "surface_model": False,
        "sources": [{"title": it["title"], "date": it.get("publicationDate")} for it in items],
    }
