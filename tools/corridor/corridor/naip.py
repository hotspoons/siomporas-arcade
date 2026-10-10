"""Imagery on the site's UTM lattice: NAIP at 30 cm in the United States, Sentinel-2 at 10 m elsewhere.

TWO NAIP SOURCES since 2026-10-10, chosen by CORRIDOR_NAIP_SOURCE (auto | pc | usgs; default auto):

  pc     Microsoft's Planetary Computer: the USDA quarter-quad COGs, found by STAC search and read
         over HTTP range requests (`naip_pc.py`, which says why and what was measured). PRIMARY.
  usgs   USGS's NAIPPlus ImageServer `exportImage`, below. The fallback: on 2026-10-10 it answered
         504 for an hour and killed two dc-metro bakes, which is why it is no longer the only one.

`auto` asks the Planetary Computer first and turns to the ImageServer when it cannot be reached (a
tile at a time, with a breaker so an outage is paid for once), or when it has no NAIP somewhere the
ImageServer might (it carries no Hawaii or Alaska). Forcing one source turns the other off — the
bake then fails rather than mixing. Either way the files are the same: same names, same lattice,
same `res_m`, cached under `<cache>/naip/` (the ImageServer's tiles as before, the Planetary
Computer's as `pc_*.jpg` with a `.json` naming the items that fed each).

THE USGS SOURCE was ported from trailworks `fetch_naip_rgb`, with two changes: the resolution is
the service's native 0.3 m rather than 1 m (USGSNAIPPlus reports pixelSize 0.3 — the current NAIP
cycle is 60 cm and some states 30 cm, so 0.3 is at or past the source and never below it), and
`bandIds=0,1,2` is passed explicitly because the service carries a fourth NIR band and we want
natural colour, not whatever the default rendering rule feels like today.

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
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.transform import from_origin

from . import BakeFault
from .geo import Frame
from . import naip_pc
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


def source_choice() -> str:
    """CORRIDOR_NAIP_SOURCE: `pc`, `usgs`, or `auto` (the default, and anything unrecognised)."""
    v = os.environ.get("CORRIDOR_NAIP_SOURCE", "auto").strip().lower()
    return v if v in ("auto", "pc", "usgs") else "auto"


def _jobs(n: int | None = None) -> int:
    return int(n) if n is not None else int(os.environ.get("CORRIDOR_NAIP_JOBS", "6") or "6")


def _atomic_write(path: Path, data: bytes) -> None:
    # Private temp + os.replace: several shards may race the same cache key, and the RWX cache is
    # lock-free by design (a published entry is immutable). A half-written file must never publish.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _fetch_one(hit: Path, params: dict, timeout: int = 300, tries: int = 9) -> bool:
    """Fetch one service tile into `hit` (atomic), returning False if it was already cached."""
    if hit.exists():
        return False
    r = _get_with_retry(SERVICE, params=params, timeout=timeout, tries=tries, session=_thread_session())
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image"):
        raise RuntimeError(f"NAIP exportImage returned {r.headers.get('content-type')}: {r.text[:200]}")
    _atomic_write(hit, r.content)
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
    return sum(1 for got in _pool([lambda h=h, p=p: _fetch_one(h, p) for h, p in missing], jobs, label) if got)


def _pool(work: list, jobs: int | None, label: str) -> list:
    """Run the callables in `work` on at most `jobs` threads (CORRIDOR_NAIP_JOBS, default 6),
    printing progress; return their results. The first failure is raised."""
    if not work:
        return []
    jobs = max(1, min(_jobs(jobs), len(work)))
    if jobs == 1:
        out = [fn() for fn in work]
        print(f"  {label}    fetched {len(out)}/{len(work)} tiles", flush=True)
        return out
    from concurrent.futures import ThreadPoolExecutor, as_completed

    out = []
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(fn) for fn in work]
        for done, fut in enumerate(as_completed(futs), 1):
            out.append(fut.result())
            if done % 5 == 0 or done == len(work):
                print(f"  {label}    fetched {done}/{len(work)} tiles ({jobs} parallel)", flush=True)
    return out


# ------------------------------------------------------------------------- the tile plan, either source


@dataclass(frozen=True)
class Tile:
    """One piece of an output raster, at most TILE_PX a side, cached on its own under <cache>/naip/.

    The cache names are keyed on the tile's own lattice (top-left corner, size, resolution), exactly
    as before, so the ImageServer tiles already on the cluster's cache volume are found again."""

    x0: float
    y1: float
    w: int
    h: int
    res: float
    epsg: int
    cache: Path

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        return (self.x0, self.y1 - self.h * self.res, self.x0 + self.w * self.res, self.y1)

    @property
    def stem(self) -> str:
        return f"{self.epsg}_{self.x0:.1f}_{self.y1:.1f}_{self.w}x{self.h}_{self.res:g}"

    @property
    def usgs(self) -> Path:
        return self.cache / "naip" / f"{self.stem}.jpg"

    @property
    def pc(self) -> Path:
        return self.cache / "naip" / f"pc_{self.stem}.jpg"

    @property
    def pc_meta(self) -> Path:
        return self.cache / "naip" / f"pc_{self.stem}.json"

    def params(self) -> dict:
        x0, y0, x1, y1 = self.bbox
        return {
            "bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": self.epsg, "imageSR": self.epsg,
            "size": f"{self.w},{self.h}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image",
        }

    def file(self, mode: str | None = None) -> Path | None:
        """The cached piece to read: the Planetary Computer's, else (unless forced to `pc`) the ImageServer's."""
        mode = mode or source_choice()
        if mode != "usgs" and self.pc.exists():
            return self.pc
        if mode != "pc" and self.usgs.exists():
            return self.usgs
        return None


def plan_tiles(frame: Frame, bbox, res: float, cache: Path, keep=None) -> list[tuple[int, int, Tile]]:
    """`(row, col, tile)` for every TILE_PX piece of the bbox's lattice at `res` that `keep(box)` wants."""
    xmin, ymin, xmax, ymax = bbox
    width = int(round((xmax - xmin) / res))
    height = int(round((ymax - ymin) / res))
    out = []
    for r0 in range(0, height, TILE_PX):
        for c0 in range(0, width, TILE_PX):
            tw, th = min(TILE_PX, width - c0), min(TILE_PX, height - r0)
            t = Tile(xmin + c0 * res, ymax - r0 * res, tw, th, res, frame.epsg, cache)
            if keep is None or keep(t.bbox):
                out.append((r0, c0, t))
    return out


def read_tile(t: Tile) -> np.ndarray:
    """The cached piece as (h, w, 3) uint8."""
    path = t.file()
    if path is None:
        raise RuntimeError(f"NAIP tile {t.stem} was planned and fetched but nothing is cached for it")
    return np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB"))


def _fetch_pc_tile(t: Tile, frame: Frame, items: list, tries: int) -> None:
    arr, used = naip_pc.compose(frame, t.bbox, t.res, items, jobs=1, tries=tries)
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(np.moveaxis(arr, 0, -1))).save(buf, format="JPEG", quality=90)
    # the sidecar first: the .jpg is what says "cached", so it must never exist without its items
    _atomic_write(t.pc_meta, json.dumps({"items": [u.record() for u in used]}).encode())
    _atomic_write(t.pc, buf.getvalue())


def fetch_tiles(frame: Frame, tiles: list[Tile], label: str = "naip", jobs: int | None = None) -> dict:
    """Make sure every tile has a cached piece, from whichever source CORRIDOR_NAIP_SOURCE allows.

    `auto`: Planetary Computer first, with SHORT patience (about two minutes of 5xx); when it fails
    — the search, or a tile read — a breaker trips and every remaining tile goes to the ImageServer
    with the full patience. A tile only fails the bake when BOTH sources failed it. Returns the
    provenance for the manifest (`provenance`)."""
    mode = source_choice()
    missing = [t for t in tiles if t.file(mode) is None]
    breaker = {"down": None}
    lock = threading.Lock()
    items: list | None = None
    if missing and mode != "usgs":
        xs = [b for t in missing for b in (t.bbox[0], t.bbox[2])]
        ys = [b for t in missing for b in (t.bbox[1], t.bbox[3])]
        try:
            items = naip_pc.search(frame.bbox_wgs(min(xs), min(ys), max(xs), max(ys)), tries=naip_pc.TRIES if mode == "pc" else naip_pc.SHORT_TRIES)
        except Exception as exc:
            if mode == "pc":
                raise BakeFault(f"naip: CORRIDOR_NAIP_SOURCE=pc and the Planetary Computer search failed: {exc}") from exc
            breaker["down"] = f"search failed: {exc}"
            print(f"  {label}    Planetary Computer unreachable ({exc}); the USGS ImageServer serves these tiles", flush=True)
        if items == [] and mode == "auto":
            # covered() said yes, so the ImageServer must have it where the catalogue does not
            breaker["down"] = "no Planetary Computer items over these tiles"
            print(f"  {label}    Planetary Computer has no NAIP over these tiles; the USGS ImageServer serves them", flush=True)
        elif items:
            years = sorted({i.year for i in items}, reverse=True)
            print(f"  {label}    Planetary Computer: {len(items)} items over {len(missing)} tiles, years {', '.join(map(str, years))}", flush=True)

    def one(t: Tile) -> str:
        if mode != "usgs" and breaker["down"] is None:
            try:
                _fetch_pc_tile(t, frame, items or [], naip_pc.TRIES if mode == "pc" else naip_pc.SHORT_TRIES)
                return "pc"
            except Exception as exc:
                if mode == "pc":
                    raise BakeFault(f"naip: CORRIDOR_NAIP_SOURCE=pc and tile {t.stem} could not be read: {exc}") from exc
                with lock:
                    if breaker["down"] is None:
                        breaker["down"] = str(exc)
                        print(f"  {label}    Planetary Computer failed ({exc}); the remaining tiles come from the USGS ImageServer", flush=True)
        try:
            _fetch_one(t.usgs, t.params())
        except Exception as exc:
            if mode == "usgs":
                raise
            raise BakeFault(f"naip: tile {t.stem}: neither source answered — Planetary Computer: {breaker['down']}; USGS ImageServer: {exc}") from exc
        return "usgs"

    _pool([lambda t=t: one(t) for t in missing], jobs, label)
    return provenance(tiles, mode)


def provenance(tiles: list[Tile], mode: str | None = None) -> dict:
    """Which source and which NAIP items fed these tiles: the manifest's record of the imagery."""
    mode = mode or source_choice()
    by_source: dict[str, int] = {}
    items: dict[str, dict] = {}
    for t in tiles:
        f = t.file(mode)
        if f is None:
            continue
        src = "pc" if f == t.pc else "usgs"
        by_source[src] = by_source.get(src, 0) + 1
        if src == "pc" and t.pc_meta.exists():
            for rec in json.loads(t.pc_meta.read_text()).get("items", []):
                items.setdefault(rec["id"], {**rec, "tiles": 0})["tiles"] += 1
    names = {"pc": "Planetary Computer NAIP (USDA quarter-quad COGs)", "usgs": "USGS NAIPPlus ImageServer (current mosaic)"}
    out: dict = {"source": " + ".join(names[k] for k in sorted(by_source)) or None, "tiles_by_source": by_source}
    if items:
        recs = sorted(items.values(), key=lambda r: (-r["year"], r["gsd_m"], r["id"]))
        out["items"] = recs
        out["years"] = sorted({r["year"] for r in recs}, reverse=True)
        out["source_res_m"] = sorted({r["gsd_m"] for r in recs})
    return out


def covered(frame: Frame, bbox: tuple[float, float, float, float]) -> bool:
    """
    Does NAIP have imagery here? Asked of the Planetary Computer's catalogue first (a STAC search,
    with the Crofton control — `naip_pc.covered`), and of the ImageServer when that cannot answer.

    An outage is never "no": a source that cannot be reached is skipped (auto) or stops the bake
    (forced), and when neither can be reached this raises BakeFault rather than dropping to
    Sentinel-2. "No" is the catalogue's empty search with a full control — and in `auto` the
    ImageServer is asked for a second opinion then, because the catalogue has no Hawaii or Alaska.
    """
    mode = source_choice()
    if mode != "usgs":
        try:
            if naip_pc.covered(frame.bbox_wgs(*bbox), tries=naip_pc.TRIES if mode == "pc" else naip_pc.SHORT_TRIES):
                return True
        except Exception as exc:
            if mode == "pc":
                raise BakeFault(f"naip coverage probe (Planetary Computer) could not get an answer, so this bake cannot tell whether NAIP covers it: {exc}") from exc
            print(f"  naip    Planetary Computer could not answer the coverage probe ({exc}); asking the USGS ImageServer", flush=True)
            return _usgs_covered(frame, bbox)
        if mode == "pc":
            print("  naip    Planetary Computer has no NAIP here (its control over Crofton answered)", flush=True)
            return False
        try:
            has = _usgs_covered(frame, bbox, tries=naip_pc.SHORT_TRIES)
        except BakeFault as exc:
            # The catalogue's "no" is a real answer, with a control; the second opinion is only
            # for the places it does not carry. Say so loudly and go with the answer we have.
            print(f"  naip    WARNING Planetary Computer has no NAIP here and the USGS ImageServer could not be asked ({exc}); treating it as uncovered", flush=True)
            return False
        if has:
            print("  naip    Planetary Computer has no NAIP here but the USGS ImageServer does; using it", flush=True)
        return has
    return _usgs_covered(frame, bbox)


def _usgs_covered(frame: Frame, bbox: tuple[float, float, float, float], tries: int = 9) -> bool:
    """
    Does the USGS ImageServer have imagery here?

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
            tries=tries,
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
    plan = plan_tiles(frame, bbox, RES, cache)
    prov = fetch_tiles(frame, [t for _, _, t in plan])
    for i, (r0, c0, t) in enumerate(plan, 1):
        mosaic[:, r0 : r0 + t.h, c0 : c0 + t.w] = np.moveaxis(read_tile(t), -1, 0)
        print(f"  naip    tile {i}/{len(plan)}", flush=True)
    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=frame.crs,
        transform=from_origin(xmin, ymax, RES, RES), compress="jpeg", photometric="ycbcr", tiled=True, jpeg_quality=88,
    ) as dst:
        dst.write(mosaic)
    return {"file": out.name, "res_m": RES, "size": [width, height], **prov}


def fetch_horizon_image(frame: Frame, out: Path, bbox: tuple[float, float, float, float], size: int) -> dict | None:
    """A size x size JPEG of NAIP over a square frame-CRS bbox (the horizon's 60 m colour).

    No georeferencing in the file: the reader knows the square. From the Planetary Computer this is
    a hundred-odd quarter-quads read at their coarsest overviews, eight at a time; from the
    ImageServer, one request. None when there is nothing to write."""
    res = (bbox[2] - bbox[0]) / size
    mode = source_choice()
    if mode != "usgs":
        tries = naip_pc.TRIES if mode == "pc" else naip_pc.SHORT_TRIES
        try:
            items = naip_pc.search(frame.bbox_wgs(*bbox), tries=tries)
            if items:
                arr, used = naip_pc.compose(frame, bbox, res, items, jobs=max(8, _jobs()), tries=tries)
                buf = io.BytesIO()
                Image.fromarray(np.ascontiguousarray(np.moveaxis(arr, 0, -1))).save(buf, format="JPEG", quality=90)
                _atomic_write(out, buf.getvalue())
                years = sorted({u.year for u in used}, reverse=True)
                print(f"  horizon imagery {size}x{size} @ {res:g} m from {len(used)} Planetary Computer items ({', '.join(map(str, years))})", flush=True)
                return {"source": "pc", "items": len(used), "years": years}
            if mode == "pc":
                print("  horizon no Planetary Computer NAIP over the horizon square; no imagery", flush=True)
                return None
        except Exception as exc:
            if mode == "pc":
                raise BakeFault(f"horizon imagery: CORRIDOR_NAIP_SOURCE=pc and the Planetary Computer failed: {exc}") from exc
            print(f"  horizon Planetary Computer failed ({exc}); asking the USGS ImageServer", flush=True)
    xmin, ymin, xmax, ymax = bbox
    r = _get_with_retry(
        SERVICE,
        params={"bbox": f"{xmin},{ymin},{xmax},{ymax}", "bboxSR": frame.epsg, "imageSR": frame.epsg, "size": f"{size},{size}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "f": "image"},
        timeout=300,
    )
    r.raise_for_status()
    if r.headers.get("content-type", "").startswith("image"):
        out.write_bytes(r.content)
        print(f"  horizon imagery {size}x{size} @ {res:g} m from the USGS ImageServer", flush=True)
        return {"source": "usgs"}
    return None
