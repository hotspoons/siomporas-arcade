"""Canopy height from the Meta/WRI global 1 m model — worldwide, and better than what we do in the US.

WHAT THIS REPLACES, EVENTUALLY. `lidar.py` pulls USGS 3DEP point clouds and builds a canopy height
model out of them: vegetation returns minus ground. That is the right thing to do where 3DEP
exists, it is a lot of bytes and CPU, and it exists nowhere outside the United States — so an
Italian pass bakes with `--skip lidar` and has no trees at all.

Meta and WRI publish the same product, precomputed, for the whole world, at the same resolution:

    s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/<tile>.tif
    56 145 tiles, ~1.19 m, EPSG:3857, COG, anonymous, with a tiles.geojson index

One tile covers the Stelvio AND Trafoi; another covers Crofton. So this is not a Europe workaround
— it is a candidate replacement for the US lidar CHM too, and the argument for that is in
DATA-OUTSIDE-US.md rather than in this docstring.

WHAT IT DOES NOT REPLACE. `lidar.py` also produces the DTM/DSM, bridge-deck heights, building
density and the along-track profile with its cut-and-fill measurements. Those come from the
CLASSIFIED point cloud and there is no global equivalent. This is the canopy layer only.

READING ZERO IS NOT READING NOTHING, and this is the trap that matters here. The Stelvio pass is
at 2757 m, above the treeline, and reads 0.0 m over a 600 m window — which is CORRECT. The way to
know it is correct rather than missing is a second window in the same tile: Trafoi, in the valley
at 1543 m, reads 4.6 m mean, 29.0 m max, 45% of pixels above 2 m. A single point sample cannot
tell those apart, so `measure()` returns both the statistics and the coverage fraction and
`__main__` prints them.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import requests

from .geo import Frame

BUCKET = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float"
INDEX = f"{BUCKET}/tiles.geojson"
# The index is 15 MB and lists every tile on Earth; it is fetched once and cached like any source.
session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"

# Same as dem.py — GDAL lists the "directory" beside every object without it, which on S3 is a
# bucket listing per tile.
VSICURL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "2",
}


def index(cache: Path) -> dict:
    """The tile index, cached on disk — 15 MB, and it does not change."""
    hit = cache / "meta_chm" / "tiles.geojson"
    if hit.exists():
        return json.loads(hit.read_text())
    hit.parent.mkdir(parents=True, exist_ok=True)
    r = session.get(INDEX, timeout=300)
    r.raise_for_status()
    hit.write_text(r.text)
    return r.json()


def tiles_for(cache: Path, w: float, s: float, e: float, n: float) -> list[str]:
    """Every tile whose footprint touches the lon/lat box, as /vsicurl paths."""
    out = []
    for feat in index(cache).get("features", []):
        ring = feat["geometry"]["coordinates"][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        if max(xs) < w or min(xs) > e or max(ys) < s or min(ys) > n:
            continue
        out.append(f"{BUCKET}/chm/{feat['properties']['tile']}.tif")
    return sorted(set("/vsicurl/" + u for u in out))


def fetch_chm(frame: Frame, bbox: tuple[float, float, float, float], out: Path, cache: Path, res: float = 1.0) -> dict:
    """The canopy height model over the site bbox, on the site lattice, in metres."""
    if out.exists():
        return {"file": out.name, "cached": True}
    w, s, e, n = frame.bbox_wgs(*bbox)
    cogs = tiles_for(cache, w, s, e, n)
    if not cogs:
        raise RuntimeError(f"no Meta/WRI canopy tile covers {w:.4f},{s:.4f},{e:.4f},{n:.4f}")
    xmin, ymin, xmax, ymax = bbox
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "gdalwarp", "-q", "-overwrite", "-t_srs", frame.crs,
            "-te", str(xmin), str(ymin), str(xmax), str(ymax), "-tr", str(res), str(res),
            "-r", "bilinear", "-ot", "Float32", "-dstnodata", "-9999",
            "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES", "-co", "PREDICTOR=3",
            *cogs, str(out),
        ],
        check=True,
        env={**os.environ, **VSICURL_ENV},
    )
    stats = measure(out)
    print(
        f"  canopy  Meta/WRI 1 m global CHM from {len(cogs)} tile(s): "
        f"mean {stats['mean_m']:.1f} m, max {stats['max_m']:.1f} m, {100 * stats['cover']:.0f}% above 2 m",
        flush=True,
    )
    return {"file": out.name, "res_m": res, "source": "Meta/WRI global canopy height (alsgedi_global_v6_float)", "tiles": len(cogs), **stats}


def measure(path: Path) -> dict:
    """
    Statistics AND the coverage fraction, because a mean of 0.0 is ambiguous on its own.

    Above the treeline the honest answer is zero. Over a failed read it is also zero. `cover` — the
    share of pixels above 2 m — is what separates them when read alongside a window that has trees.
    """
    import numpy as np
    import rasterio

    with rasterio.open(path) as src:
        a = np.ma.masked_equal(src.read(1), -9999)
    if a.count() == 0:
        return {"mean_m": 0.0, "max_m": 0.0, "cover": 0.0, "valid_px": 0}
    return {
        "mean_m": round(float(a.mean()), 2),
        "max_m": round(float(a.max()), 2),
        "cover": round(float((a > 2).mean()), 4),
        "valid_px": int(a.count()),
    }


def main() -> None:
    """`python -m corridor.canopy <slug>` — add a canopy layer to a site baked without lidar."""
    import argparse
    import sys

    ap = argparse.ArgumentParser(prog="corridor.canopy", description=__doc__.split("\n")[0])
    ap.add_argument("slug")
    ap.add_argument("--data", default=os.environ.get("CORRIDOR_DATA"), help="defaults to $CORRIDOR_DATA")
    ap.add_argument("--res", type=float, default=1.0)
    a = ap.parse_args()
    data = Path(a.data) if a.data else Path(__file__).resolve().parent.parent / "data"
    site = data / "sites" / a.slug
    if not (site / "site.json").exists():
        sys.exit(f"no baked site at {site}")
    sj = json.loads((site / "site.json").read_text())
    frame = Frame.at(sj["lon"], sj["lat"])
    bbox = tuple(sj["bbox_utm"])
    info = fetch_chm(frame, bbox, site / "lidar" / "chm.tif", data / "cache", res=a.res)
    man = json.loads((site / "manifest.json").read_text())
    man["canopy"] = info
    (site / "manifest.json").write_text(json.dumps(man, indent=1, default=str))
    print(f"  wrote {site / 'lidar' / 'chm.tif'} and stamped manifest.canopy")


if __name__ == "__main__":
    main()
