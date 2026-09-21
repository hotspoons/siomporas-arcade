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

import subprocess
from pathlib import Path

import requests

from .geo import Frame

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
    import time

    if dest.exists() and (size is None or dest.stat().st_size == size):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    candidates = [u for u in (s3_mirror(url), url) if u]
    last: Exception | None = None
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
                tmp.replace(dest)
                return dest
            except Exception as exc:  # a dropped connection mid-GB is ordinary; retry the same URL
                last = exc
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed for {url}: {last}")


def discover_1m(w: float, s: float, e: float, n: float) -> list[dict]:
    r = session.get(
        TNM,
        params={"datasets": "Digital Elevation Model (DEM) 1 meter", "bbox": f"{w},{s},{e},{n}", "prodFormats": "GeoTIFF", "outputFormat": "JSON", "max": 100},
        timeout=90,
    )
    r.raise_for_status()
    items = r.json().get("items", [])
    items.sort(key=lambda it: it.get("publicationDate", ""))  # newest LAST: gdalwarp paints later inputs on top
    return items


def fetch_dem(frame: Frame, bbox: tuple[float, float, float, float], out: Path, cache: Path) -> dict:
    if out.exists():
        return {"file": out.name, "cached": True}
    w, s, e, n = frame.bbox_wgs(*bbox)
    items = discover_1m(w, s, e, n)
    if not items:
        raise RuntimeError("no 1 m DEM coverage from TNM for this bbox")
    tiles = []
    for it in items:
        name = it["downloadURL"].rsplit("/", 1)[1]
        print(f"  dem     {name} ({it.get('sizeInBytes', 0) / 2**20:.0f} MiB, {it.get('publicationDate')})", flush=True)
        tiles.append(download(it["downloadURL"], cache / "usgs1m" / name, it.get("sizeInBytes")))
    xmin, ymin, xmax, ymax = bbox
    cmd = [
        "gdalwarp", "-q", "-overwrite", "-t_srs", frame.crs, "-te", str(xmin), str(ymin), str(xmax), str(ymax),
        "-tr", "1", "1", "-r", "bilinear", "-dstnodata", "-9999", "-ot", "Float32",
        "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "PREDICTOR=3",
        *[str(t) for t in tiles], str(out),
    ]
    subprocess.run(cmd, check=True)
    return {"file": out.name, "sources": [{"title": it["title"], "date": it.get("publicationDate")} for it in items]}
