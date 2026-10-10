"""NAIP from Microsoft's Planetary Computer: a STAC catalogue of the USDA's own quarter-quad COGs.

WHY THIS EXISTS. On 2026-10-10 USGS's NAIP ImageServer (USGSNAIPPlus/exportImage, which `naip.py`
was built on) answered HTTP 504 for about an hour and killed two dc-metro-take-2 bakes. Rich asked
whether we could read the NAIP open data instead of their API. Measured the same day:

  AWS Open Data (naip-visualization / naip-analytic / naip-source, us-west-2)
        REQUESTER PAYS — an anonymous read is refused, so every bake would need AWS credentials and
        would pay for its own egress. Not used.
  Planetary Computer (`naip` collection)
        anonymous: a STAC search, plus a free SAS token appended to each asset href. The assets
        are Cloud-Optimized GeoTIFFs on naipeuwest.blob.core.windows.net (RGB+NIR, DEFLATE, 512 px
        blocks, six 2x overviews); a range read answered 206 in 0.7 s, one stream ran 7.4 MB/s.
        Over downtown DC it returns 2023 for Virginia (0.6 m) and Maryland (0.3 m — sharper than
        the 0.6 m the ImageServer serves there), and every earlier cycle back to 2011.

So this is the PRIMARY source, and the ImageServer is the fallback (`naip.py` decides which; this
module only knows the catalogue and how to read it). What it does NOT have: Hawaii and Alaska
(searches there return nothing, measured), which is why an empty answer here is checked against
the ImageServer before a bake drops to Sentinel-2.

WHICH ITEMS, per area: the newest year first, the finer resolution first within a year, then the
older items only where the newer ones leave a hole — a state line (VA 2023 meets MD 2023 at the
Potomac and the two are separate items), a quarter-quad missing from a cycle, the black collar of a
quarter-quad's rotated footprint. Gaps are filled per PIXEL, not averaged: a pixel comes from
exactly one item, so there is never a doubled or blended seam, only a boundary between two flights.
This is the lidar's "newest over half, then gap cover" (lidar_sources.plan_cover) with the
threshold at zero: NAIP vintages are one programme flying one spec, so there is no older-but-better
survey for a newer one to lose to — newest simply wins wherever it has a pixel.

READING. Each item is opened over /vsicurl/ with the SAS token, at the coarsest overview that is
still at least as fine as the lattice asked for (a 0.3 m quarter-quad read for a 0.6 m lattice uses
its 0.6 m overview, a quarter of the bytes; the 60 m horizon reads 19.2 m overviews), and warped
onto the site's own lattice. The resolution is the CALLER's — `NAIP_RES_M` for the tiled bakes,
`naip.RES` for a corridor — so nothing downstream changes.

REGISTRATION, measured 2026-10-10 over Crofton: this path agrees with `gdalwarp` of the same COG to
0.003 px, and so with every other raster the bake reprojects through PROJ (the 3DEP DEM, the lidar
— NAD83 to WGS84 as PROJ's null transformation). The ImageServer does NOT: asked for the item's own
EPSG:26918 it matches the COG to 0.000 px, asked for EPSG:32618 it moves the picture exactly one
0.6 m row north (0.96 m at 0.3 m) — a datum transformation of its own on the server. So imagery
from here sits 0.6-1 m south of what the ImageServer used to give, and that is the one that lines
up with the DEM and the lidar. A raster that mixes the two sources (auto's fallback, tile by tile)
has that step at the tile seams.

THE LOUD-FAILURE RULE (reference-silent-success-family): an outage is never an answer. "Not
covered" means one thing only — the search over the area came back empty AND the same search over
a point we know NAIP covers (Crofton, MD: flown every cycle) came back full. A control that is
also empty means the catalogue is broken, and that raises.
"""
from __future__ import annotations

import datetime as _dt
import os
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import requests
import shapely
from shapely.geometry import box, shape

STAC = os.environ.get("CORRIDOR_NAIP_PC_STAC", "https://planetarycomputer.microsoft.com/api/stac/v1").rstrip("/")
TOKEN_URL = os.environ.get("CORRIDOR_NAIP_PC_TOKEN", "https://planetarycomputer.microsoft.com/api/sas/v1/token/naip")
COLLECTION = "naip"
#: Crofton, Maryland (the crofton-triangle site): NAIP has flown it in every cycle since 2011 at
#: least (the catalogue lists 2011, 2013, 2015, 2017, 2018, 2021 and 2023 items over it). An empty
#: search here means the catalogue is not answering, whatever the HTTP status said.
CONTROL_BBOX = (-76.6715, 39.0070, -76.6700, 39.0085)
#: Refresh the SAS token when it has less than this left. Tokens are issued for about an hour; a
#: tile read takes seconds, so ten minutes of margin means a token never expires mid-read.
TOKEN_MARGIN_S = 600.0
#: Full patience, the same as the USGS helpers since 2026-10-10: 10, 20, 40 then 60 s between nine
#: tries, about six minutes for an outage to pass. A source with a fallback behind it is given less
#: (SHORT_TRIES, about two minutes) so an outage costs two minutes, not seven, before the other one.
TRIES = 9
SHORT_TRIES = 5
#: Ignore holes smaller than this share of a piece when looking for an older item to fill them;
#: a handful of pixels at the edge of a resampling kernel is not worth opening another COG for.
GAP_MIN_FRAC = 0.0005
#: NAIP REDACTS some sites by painting them pure white, and that white is in the COG itself:
#: dc-metro-take-2's western block (2026-10-10) had a 0.9 x 1.3 km block of (255, 255, 255) at
#: -77.06, 38.945 in md_m_3807708_ne 2023, where Virginia's 2023 and both states' 2021 items have
#: ground. A white rectangle at least this big (and filling its own bounding box) is treated as a
#: hole, so the next item fills it. A saturated white roof is far smaller, or not a full rectangle.
REDACT_MIN_M2 = 10_000.0

#: GDAL over HTTP. The COGs are 512 px blocks, pixel-interleaved: merge adjacent ranges into one
#: request and keep the headers cached so re-opening an item at an overview level is free.
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MULTIPLEX": "YES",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": str(32 << 20),
}
# rasterio's manylinux wheel brings its own libcurl, which looks for CA certificates in its own
# build's places; point it at the system bundle (Debian's, in the baker image) when there is one.
for _ca in ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"):
    if os.path.exists(_ca) and not os.environ.get("CURL_CA_BUNDLE"):
        GDAL_ENV["GDAL_CURL_CA_BUNDLE"] = _ca
        break

session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"


def _backoff(attempt: int) -> float:
    return float(min(60, 10 * 2**attempt))


class BandLayoutError(ValueError):
    """An item whose bands cannot be shown to be red, green and blue. Not transient: never retried."""


def retry(fn, what: str, tries: int = TRIES):
    """Call `fn()` until it returns, sleeping 10/20/40/60 s between tries; raise naming `what`."""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            return fn()
        except BandLayoutError:
            raise
        except Exception as exc:  # noqa: BLE001 — every failure here is a transient until proven otherwise
            last = exc
        if attempt + 1 < tries:
            time.sleep(_backoff(attempt))
    raise RuntimeError(f"{what}: {last}")


def _http_json(method: str, url: str, body: dict | None = None, timeout: int = 120) -> dict:
    """One request. A 5xx or a non-JSON 200 raises (so `retry` asks again); a 4xx raises too."""
    r = session.request(method, url, json=body, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code} from {url}: {r.text[:200]!r}")
    try:
        return r.json()
    except ValueError as exc:
        raise RuntimeError(f"{url} answered {r.headers.get('content-type')} that is not JSON: {r.text[:200]!r}") from exc


# ---------------------------------------------------------------------------------------- token


class Token:
    """The SAS token for the `naip` container, refreshed when it nears `msft:expiry`."""

    def __init__(self):
        self._lock = threading.Lock()
        self.value: str | None = None
        self.expiry = 0.0

    def get(self, force: bool = False, tries: int = TRIES) -> str:
        with self._lock:
            if force or self.value is None or self.expiry - time.time() < TOKEN_MARGIN_S:
                doc = retry(lambda: _http_json("GET", TOKEN_URL, timeout=60), "Planetary Computer SAS token", tries)
                tok = doc.get("token")
                exp = doc.get("msft:expiry")
                if not tok or not exp:
                    raise RuntimeError(f"the SAS token response has no token/expiry: {sorted(doc)}")
                self.value = tok
                self.expiry = _dt.datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp()
            return self.value


TOKEN = Token()


def dataset_path(href: str, tries: int = TRIES) -> str:
    """What GDAL opens: a signed /vsicurl/ URL for a blob, or the path itself (the tests' local COGs)."""
    if href.startswith(("http://", "https://")):
        return "/vsicurl/" + href + ("&" if "?" in href else "?") + TOKEN.get(tries=tries)
    return href


# ---------------------------------------------------------------------------------------- items


@dataclass
class Item:
    id: str
    href: str
    date: str          # acquisition date, YYYY-MM-DD
    year: int
    state: str
    gsd: float         # metres
    footprint: object  # shapely geometry, WGS84
    #: 1-based (red, green, blue) band indexes from the asset's `eo:bands` common names, or None
    #: when the catalogue does not say (then the COG's own colour interpretation must)
    bands: tuple[int, int, int] | None = None
    _utm: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def month(self) -> int:
        return int(self.date[5:7])

    def leaf_on(self) -> bool:
        lo, hi = leaf_on_months()
        return lo <= self.month <= hi

    def rank_key(self):
        """LEAF-ON within LEAF_ON_YEARS of a newer flight first, then the newest year, the finer
        resolution, the later date.

        Rich cares how the world looks. Virginia flew NAIP 2023 in October and November: over
        Arlington it is red maples and bare branches beside Maryland's September 2023, a seam at
        every quarter-quad (dc-metro-take-2's western block, 2026-10-10). Virginia also flew
        2021-09-10, leaf-on. So a leaf-on item counts as LEAF_ON_YEARS (+ a half, to win the tie)
        newer than it is: it beats a leaf-off item up to that many years newer, and loses to one
        newer still. Two leaf-on items, or two leaf-off ones, compare by year as before."""
        bonus = leaf_on_years() + 0.5 if self.leaf_on() else 0.0
        return (-(self.year + bonus), -self.year, self.gsd, tuple(-int(p) for p in self.date.split("-")))

    def footprint_in(self, frame):
        g = self._utm.get(frame.epsg)
        if g is None:
            g = shapely.transform(self.footprint, lambda xy: np.column_stack(frame.from_wgs(xy[:, 0], xy[:, 1])))
            self._utm[frame.epsg] = g
        return g

    def record(self) -> dict:
        return {"id": self.id, "state": self.state, "year": self.year, "date": self.date, "gsd_m": self.gsd, "leaf_on": self.leaf_on()}


def leaf_on_months() -> tuple[int, int]:
    """CORRIDOR_NAIP_LEAF_ON: the leaf-on months, inclusive, as `5-9` (May to September, the default).

    May, not June: Maryland flew a third of its 2023 quarter-quads on 2023-05-25, in full leaf,
    and with June-September crofton-triangle lost its 2023 0.3 m year to 2021 0.6 m (2023 leaf-on
    covered 82.7%). October stays out: Virginia's 2023-10-11 flight is already turning."""
    v = os.environ.get("CORRIDOR_NAIP_LEAF_ON", "5-9").strip()
    try:
        lo, hi = (int(x) for x in v.split("-", 1))
        if 1 <= lo <= hi <= 12:
            return lo, hi
    except ValueError:
        pass
    return 5, 9


def leaf_on_years() -> int:
    """CORRIDOR_NAIP_LEAF_ON_YEARS: how many years older a leaf-on item may be and still beat a
    leaf-off one (default 2; 0 turns the preference off except within one year)."""
    try:
        return max(0, int(os.environ.get("CORRIDOR_NAIP_LEAF_ON_YEARS", "2")))
    except ValueError:
        return 2


def ranking_rule() -> str:
    lo, hi = leaf_on_months()
    return (f"per pixel: leaf-on (months {lo}-{hi}) over a leaf-off item up to {leaf_on_years()} years newer, "
            "then the newest year, the finer resolution, the later date; older items only fill holes")


def rule_tag() -> str:
    """The ranking knobs as a cache-name suffix: a piece composed under one rule is never reused
    under another (changing CORRIDOR_NAIP_LEAF_ON* re-reads, it does not silently keep old pieces)."""
    lo, hi = leaf_on_months()
    return f"lo{lo}-{hi}y{leaf_on_years()}"


def rgb_bands(asset: dict) -> tuple[int, int, int] | None:
    """The asset's red, green and blue band indexes (1-based) from its `eo:bands` (or
    `raster:bands`) common names. None when the catalogue lists no bands at all; BandLayoutError
    when it lists bands and red, green or blue is not among them (a CIR or NIR-only product)."""
    listed = asset.get("eo:bands") or asset.get("raster:bands")
    if not listed:
        return None
    names = [str(b.get("common_name") or b.get("name") or "").lower() for b in listed]
    try:
        return tuple(names.index(c) + 1 for c in ("red", "green", "blue"))  # type: ignore[return-value]
    except ValueError:
        raise BandLayoutError(f"{asset.get('href', '?')}: bands {names} have no red/green/blue") from None


def item_from_feature(f: dict) -> Item:
    p = f["properties"]
    date = (p.get("datetime") or p.get("start_datetime") or "1900-01-01")[:10]
    asset = f["assets"]["image"]
    return Item(
        id=f["id"],
        href=asset["href"],
        date=date,
        year=int(p.get("naip:year") or date[:4]),
        state=str(p.get("naip:state") or ""),
        gsd=float(p.get("gsd") or 1.0),
        footprint=shape(f["geometry"]),
        bands=rgb_bands(asset),
    )


def resolve_bands(item: Item, colorinterp) -> tuple[int, int, int]:
    """The (red, green, blue) bands to read, NEVER assumed: the catalogue's `eo:bands` and the COG's
    own colour interpretation must agree where both speak, and at least one of them must."""
    names = [getattr(ci, "name", str(ci)).lower() for ci in colorinterp]
    from_file = None
    if all(c in names for c in ("red", "green", "blue")):
        from_file = tuple(names.index(c) + 1 for c in ("red", "green", "blue"))
    if item.bands is not None and from_file is not None and item.bands != from_file:
        raise BandLayoutError(f"{item.id}: the catalogue says RGB is bands {item.bands}, the file says {from_file} ({names})")
    bands = item.bands or from_file
    if bands is None:
        raise BandLayoutError(f"{item.id}: neither the catalogue nor the file says which bands are red, green and blue ({names})")
    return bands


def search_features(bbox_wgs, limit: int = 250, max_pages: int = 40, tries: int = TRIES) -> list[dict]:
    """Every `naip` feature over a WGS84 bbox, following the `next` links (a 60 km horizon is ~800)."""
    body = {"collections": [COLLECTION], "bbox": [round(v, 6) for v in bbox_wgs], "limit": limit}
    url, method = f"{STAC}/search", "POST"
    feats: list[dict] = []
    for _ in range(max_pages):
        doc = retry(lambda: _http_json(method, url, body), f"Planetary Computer STAC search {body.get('bbox')}", tries)
        if "features" not in doc:
            # a 200 that is not a FeatureCollection is not an answer (the silent-success family)
            raise RuntimeError(f"STAC search answered without `features`: {str(doc)[:200]}")
        feats.extend(doc["features"])
        nxt = next((ln for ln in doc.get("links", []) if ln.get("rel") == "next"), None)
        if not nxt or not doc["features"]:
            return feats
        url = nxt["href"]
        method = nxt.get("method", "GET").upper()
        body = ({**body, **nxt["body"]} if nxt.get("merge") else nxt.get("body")) if method == "POST" else None
    raise RuntimeError(f"STAC search over {bbox_wgs} still had a next page after {max_pages} pages")


_SEARCHED: dict = {}
_SEARCH_LOCK = threading.Lock()


def search(bbox_wgs, tries: int = TRIES) -> list[Item]:
    """The items over a WGS84 bbox, best first (`Item.rank_key`). Memoised for the process."""
    key = tuple(round(v, 5) for v in bbox_wgs)
    with _SEARCH_LOCK:
        hit = _SEARCHED.get(key)
    if hit is not None:
        return hit
    items = []
    for f in search_features(bbox_wgs, tries=tries):
        try:
            items.append(item_from_feature(f))
        except BandLayoutError as exc:
            # a product that is not natural colour (CIR, NIR-only) is never a candidate
            print(f"  naip    SKIPPED {f.get('id')}: {exc}", flush=True)
    items.sort(key=Item.rank_key)
    with _SEARCH_LOCK:
        _SEARCHED[key] = items
    return items


# ------------------------------------------------------------------------------------ one year


@dataclass
class YearPolicy:
    """ONE YEAR for the whole area being baked (Rich, 2026-10-10: "prefer one year everywhere").

    Per-pixel newest-first stitched Maryland's September 2023 to Virginia's November 2023 across
    Arlington, and the leaf-on preference still left a seam wherever one state's newest leaf-on
    year met the other's. So the bake first picks the newest acquisition YEAR whose leaf-on items
    cover the whole area (all but `CORRIDOR_NAIP_YEAR_MAX_BARE`, default 2 %, of what ANY year
    covers — open water and other countries do not count against a year), and reads only that
    year's leaf-on items, finer first; everything else only fills holes (redactions, collars,
    edges) in the existing ranking. The area is the WORLD's bbox, so every shard of a world, and
    every tile of a shard, picks the same year. `year` None is the per-pixel ranking: forced
    (`CORRIDOR_NAIP_YEAR=off`), or no year covers enough (`why` says which)."""

    year: int | None
    why: str
    coverage: dict = field(default_factory=dict)

    @property
    def tag(self) -> str:
        return f"y{self.year}" if self.year is not None else ("yoff" if self.why.startswith("off") else "ynone")

    def record(self) -> dict:
        return {"year": self.year, "why": self.why, "coverage": self.coverage}


def year_setting() -> str:
    """CORRIDOR_NAIP_YEAR: `auto` (default), a four-digit year, or `off`."""
    v = os.environ.get("CORRIDOR_NAIP_YEAR", "auto").strip().lower()
    return v if v in ("auto", "off") or (v.isdigit() and len(v) == 4) else "auto"


def year_max_bare() -> float:
    try:
        return min(1.0, max(0.0, float(os.environ.get("CORRIDOR_NAIP_YEAR_MAX_BARE", "0.02"))))
    except ValueError:
        return 0.02


def year_coverage(items: list[Item], frame, area, year: int) -> dict:
    """How much of `area` (frame CRS geometry) `year`'s LEAF-ON items cover: in all (`share`, of
    what any item covers) and per state (`by_state`, of the same)."""
    coverable = shapely.union_all([it.footprint_in(frame) for it in items]).intersection(area)
    denom = max(coverable.area, 1e-9)
    mine = [it for it in items if it.year == year and it.leaf_on()]
    states: dict[str, float] = {}
    for st in sorted({it.state for it in mine}):
        g = shapely.union_all([it.footprint_in(frame) for it in mine if it.state == st]).intersection(coverable)
        states[st] = round(g.area / denom, 4)
    got = shapely.union_all([it.footprint_in(frame) for it in mine]).intersection(coverable) if mine else None
    return {"share": round((got.area if got is not None else 0.0) / denom, 4), "by_state": states,
            "months": sorted({it.date[:7] for it in mine})}


def year_policy(frame, area_bbox, tries: int = TRIES) -> YearPolicy:
    """The year to bake `area_bbox` (frame CRS: the world's or site's whole extent) from."""
    setting = year_setting()
    if setting == "off":
        return YearPolicy(None, "off: CORRIDOR_NAIP_YEAR=off, the per-pixel ranking")
    items = search(frame.bbox_wgs(*area_bbox), tries=tries)
    area = box(*area_bbox)
    if setting != "auto":
        y = int(setting)
        return YearPolicy(y, f"forced: CORRIDOR_NAIP_YEAR={y}", year_coverage(items, frame, area, y) if items else {})
    tried = {}
    for y in sorted({it.year for it in items if it.leaf_on()}, reverse=True):
        cov = year_coverage(items, frame, area, y)
        tried[y] = cov["share"]
        if 1.0 - cov["share"] <= year_max_bare() + 1e-9:
            newer = ", ".join(f"{yy} covers {100 * sh:.1f}%" for yy, sh in tried.items() if yy != y)
            return YearPolicy(y, f"the newest year whose leaf-on items cover {100 * cov['share']:.1f}% of the area"
                                 + (f" ({newer})" if newer else ""), cov)
    best = ", ".join(f"{yy} {100 * sh:.1f}%" for yy, sh in tried.items()) or "no leaf-on items"
    return YearPolicy(None, f"no leaf-on year covers {100 * (1 - year_max_bare()):.0f}% of the area ({best}): the per-pixel ranking")


def rank_with_year(item: Item, year: int | None):
    """The order under a YearPolicy: the chosen year's leaf-on items first (finer, then later), then
    everything else in `Item.rank_key` order — which is the whole order when `year` is None."""
    if year is not None and item.year == year and item.leaf_on():
        return (0, item.gsd, tuple(-int(p) for p in item.date.split("-")))
    return (1, *item.rank_key())


def covered(bbox_wgs, tries: int = TRIES) -> bool:
    """Does the catalogue hold NAIP over this WGS84 bbox? A search, never an image read.

    True when any item intersects it. False ONLY when the search is empty and the control search
    over Crofton is not: the catalogue answered, and it has nothing here. An empty control raises —
    a catalogue that has nothing anywhere is broken, not telling us about this place.
    """
    if search(bbox_wgs, tries=tries):
        return True
    control = search_features(CONTROL_BBOX, limit=1, max_pages=1, tries=tries)
    if not control:
        raise RuntimeError(
            f"the NAIP search over {tuple(round(v, 4) for v in bbox_wgs)} was empty and so was the control over Crofton, MD, "
            "which NAIP covers every cycle: the catalogue is not answering, so this says nothing about coverage"
        )
    return False


# ------------------------------------------------------------------------------------- reading


def overview_level(base_res: float, factors: list[int], want_res: float) -> int | None:
    """The `OVERVIEW_LEVEL` to open: the coarsest overview whose pixels are still no coarser than
    `want_res`, or None for full resolution. A 0.3 m item for a 0.6 m lattice → 0 (its 2x)."""
    best = None
    for i, f in enumerate(factors):
        if base_res * f <= want_res * 1.001:
            best = i
    return best


def _window(bounds, x0: float, y1: float, res: float, w: int, h: int, pad: int = 2):
    """Pixel window (r0, r1, c0, c1) of a frame-CRS box on the piece's lattice, padded and clipped."""
    bx0, by0, bx1, by1 = bounds
    c0 = max(0, int(np.floor((bx0 - x0) / res)) - pad)
    c1 = min(w, int(np.ceil((bx1 - x0) / res)) + pad)
    r0 = max(0, int(np.floor((y1 - by1) / res)) - pad)
    r1 = min(h, int(np.ceil((y1 - by0) / res)) + pad)
    return r0, r1, c0, c1


def warp_item(item: Item, frame, x0: float, y1: float, res: float, w: int, h: int, tries: int = TRIES) -> np.ndarray:
    """`item`'s RGB warped onto a w x h lattice at `res` whose top-left corner is (x0, y1) in the
    frame's CRS. (3, h, w) uint8; 0 in all three bands where the item has no pixel."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject

    def once() -> np.ndarray:
        with rasterio.Env(**GDAL_ENV):
            path = dataset_path(item.href, tries=tries)
            with rasterio.open(path) as src0:
                lvl = overview_level(float(src0.res[0]), src0.overviews(1), res)
            with rasterio.open(path, **({"overview_level": lvl} if lvl is not None else {})) as src:
                bands = resolve_bands(item, src.colorinterp)
                dst = np.zeros((3, h, w), dtype=np.uint8)
                down = res / float(src.res[0])
                reproject(
                    source=rasterio.band(src, bands),
                    destination=dst,
                    src_nodata=0,
                    dst_transform=from_origin(x0, y1, res, res),
                    dst_crs=frame.crs,
                    dst_nodata=0,
                    # at or near 1:1 a bilinear kernel; well below the source (the horizon's 60 m
                    # from a 19 m overview) every source pixel under the target pixel, averaged
                    resampling=Resampling.average if down >= 1.5 else Resampling.bilinear,
                    # a pixel is no-data only when R, G and B are all 0 (the quarter-quad's collar),
                    # never because one channel of real ground happened to be 0
                    UNIFIED_SRC_NODATA="YES",
                )
                return dst

    def attempt() -> np.ndarray:
        try:
            return once()
        except Exception as exc:
            # an expired or revoked SAS token reads as HTTP 403 from the blob; get a fresh one
            if "403" in str(exc) or "AuthenticationFailed" in str(exc):
                TOKEN.get(force=True, tries=tries)
            raise

    return retry(attempt, f"Planetary Computer read of {item.id}", tries)


def redacted(sub: np.ndarray, res: float) -> np.ndarray:
    """Pixels of a (3, h, w) piece inside a pure-white redaction rectangle (see REDACT_MIN_M2),
    grown by two pixels so the resampled edge of the white goes with it."""
    white = (sub == 255).all(axis=0)
    out = np.zeros(white.shape, dtype=bool)
    if white.sum() * res * res < REDACT_MIN_M2:
        return out
    from scipy import ndimage

    lab, n = ndimage.label(white)
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        blob = lab[sl] == i
        if blob.sum() * res * res >= REDACT_MIN_M2 and blob.mean() >= 0.9:
            out[sl] |= blob
    return ndimage.binary_dilation(out, iterations=2) if out.any() else out


def _gap_geometry(gap: np.ndarray, x0: float, y1: float, res: float, cells: int = 32):
    """The holes in `gap` as a union of coarse cell boxes in the frame CRS, for the footprint test."""
    h, w = gap.shape
    ch, cw = max(1, -(-h // cells)), max(1, -(-w // cells))
    boxes = []
    for r in range(0, h, ch):
        for c in range(0, w, cw):
            blk = gap[r : r + ch, c : c + cw]
            if blk.mean() > 0.01:
                boxes.append(box(x0 + c * res, y1 - (r + blk.shape[0]) * res, x0 + (c + blk.shape[1]) * res, y1 - r * res))
    return shapely.union_all(boxes) if boxes else None


def compose(frame, bbox, res: float, items: list[Item], jobs: int = 1, tries: int = TRIES, max_fill: int = 12, year: int | None = None):
    """The (3, h, w) RGB mosaic of `items` over a frame-CRS bbox at `res`, and the items that fed it.

    Pass 1 reads the PLAN: items in rank order that each add footprint the ones before them did not
    cover (the older ones fall away here). Each is read only over its footprint inside the bbox and
    they are read concurrently (`jobs`) — the horizon's 60 km square is a hundred quarter-quads — but
    composited in rank order, filling only pixels still empty, so the newest wins every pixel it has.
    Pass 2 fills what is still a hole (a collar, a missing quarter-quad) from the remaining items,
    newest first, reading each only over the hole. With a `year` (YearPolicy) that year's leaf-on
    items lead the order and everything else is only ever gap fill.
    """
    xmin, ymin, xmax, ymax = bbox
    w = int(round((xmax - xmin) / res))
    h = int(round((ymax - ymin) / res))
    piece = box(xmin, ymin, xmax, ymax)
    out = np.zeros((3, h, w), dtype=np.uint8)
    gap = np.ones((h, w), dtype=bool)
    cands = sorted((it for it in items if it.footprint_in(frame).intersects(piece)), key=lambda it: rank_with_year(it, year))
    plan: list[Item] = []
    bare = piece
    for it in cands:
        if bare.is_empty or bare.area < piece.area * 1e-6:
            break
        if it.footprint_in(frame).intersection(bare).area > piece.area * 1e-6:
            plan.append(it)
            bare = bare.difference(it.footprint_in(frame))
    used: list[Item] = []

    def read(it: Item, bounds):
        r0, r1, c0, c1 = _window(bounds, xmin, ymax, res, w, h)
        if r1 <= r0 or c1 <= c0:
            return it, (r0, r1, c0, c1), None
        try:
            return it, (r0, r1, c0, c1), warp_item(it, frame, xmin + c0 * res, ymax - r0 * res, res, c1 - c0, r1 - r0, tries)
        except BandLayoutError as exc:
            # never paint a band we cannot name as colour; the next item fills, a hole is reported
            print(f"  naip    SKIPPED {it.id}: {exc}", flush=True)
            return it, (r0, r1, c0, c1), None

    def paste(it: Item, win, sub) -> None:
        if sub is None:
            return
        r0, r1, c0, c1 = win
        g = gap[r0:r1, c0:c1]
        take = g & (sub != 0).any(axis=0) & ~redacted(sub, res)
        if take.any():
            out[:, r0:r1, c0:c1][:, take] = sub[:, take]
            g[take] = False
            used.append(it)

    reads = [(it, it.footprint_in(frame).intersection(piece).bounds) for it in plan]
    if jobs > 1 and len(reads) > 1:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=min(jobs, len(reads))) as ex:
            for res_ in ex.map(lambda a: read(*a), reads):  # `map` yields in rank order
                paste(*res_)
    else:
        for a in reads:  # one at a time: a 2.4 km tile's read is 48 MB, so do not hold them all
            paste(*read(*a))

    in_plan = {it.id for it in plan}
    tried = 0
    for it in cands:
        if it.id in in_plan or tried >= max_fill or gap.mean() < GAP_MIN_FRAC:
            continue
        holes = _gap_geometry(gap, xmin, ymax, res)
        if holes is None:
            break
        fp = it.footprint_in(frame)
        if not fp.intersects(holes):
            continue
        tried += 1
        paste(*read(it, fp.intersection(holes).bounds))
    return out, used
