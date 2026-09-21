"""What grows beside this road: vegetation type, species mix, ground cover, and the rain that
decides what colour any of it is in a given month.

Three sources, each doing the one thing it is best at.

**LANDFIRE Existing Vegetation Type (EVT)** is the canonical layer. 30 m, CONUS + AK + HI, updated
annually (LF2024 here), ~1000 NVC ecological systems with names that are already a brief — "Acadian
Low-Elevation Spruce-Fir Forest", "California Coastal Redwood Forest", "Northern California Coastal
Scrub". It is the only candidate that covers every site, carries NON-forest classes (which is most
of what Rich is asking for: the brown hillside is a vegetation class, not an absence of one), and
whose attribute table hands over a machine-readable hierarchy — `EVT_LF` (Tree/Shrub/Herb/Sparse/
Agriculture/Developed/Water), `EVT_PHYS` (Conifer/Hardwood/Shrubland/Grassland/...) and, the useful
one, `EVT_SBCLS`, which says *evergreen*, *deciduous*, *mixed*, *perennial graminoid* or **annual
graminoid/forb**. That last class is California's summer brown, named by the data.

**USFS FHP tree-species basal area** (Forest Health Technology Enterprise Team, the raster suite
behind NIDRM 2013–2027) refines EVT's class into named species with weights: 340 species at 30 m,
modelled from FIA plots, one slice per species per year in a multidimensional ImageServer. Where it
has data it is the difference between "conifer forest" and "red spruce with white spruce and a
little balsam fir". Where it does not — and over Big Sur it does not; see the traps below — the
species fall back to the EVT class NAME, tokenised against FIA's own species vocabulary.

**Daymet v4** (ORNL DAAC, 1 km daily, 1980–) gives the monthly rain and temperature. This is the
"government climate data" Rich guessed at, used for the thing climate is actually good for. Climate
cannot tell you what is standing beside the road — it tells you what COLOUR it is in September.
Big Sur takes 2 mm of rain in June–August, 0.2 % of its year; Chesterfield Road takes 419 mm, 32 %
of its year. That one ratio is the whole summer-brown/winter-green inversion, measured, and it is
why the same `summer` season must paint two different hillsides.

Everything is cached under `data/cache/` by request hash, so a re-bake never leaves the machine.

Credits: LANDFIRE (USGS/USFS, public domain), USFS FHP/FIA (public domain), Daymet v4 —
Thornton et al. 2022, ORNL DAAC, https://doi.org/10.3334/ORNLDAAC/2129.
"""
from __future__ import annotations

import csv
import datetime
import hashlib
import io
import json
import math
import re
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.features import rasterize
from rasterio.io import MemoryFile
from shapely.geometry import LineString, Polygon

from .geo import Frame

# LANDFIRE serves its rasters from the LANDFIRE Product Service host; the three regional mosaics
# are separate services, so the site's own extent picks one (there is no single national EVT).
LF_HOST = "https://lfps.usgs.gov/arcgis/rest/services"
LF_YEAR = "LF2024"
EVT_SERVICES = [
    ("CONUS", f"{LF_HOST}/Landfire_{LF_YEAR}/{LF_YEAR}_EVT_CONUS/ImageServer"),
    ("AK", f"{LF_HOST}/Landfire_{LF_YEAR}/{LF_YEAR}_EVT_AK/ImageServer"),
    ("HI", f"{LF_HOST}/Landfire_{LF_YEAR}/{LF_YEAR}_EVT_HI/ImageServer"),
]
EVT_CSV = "https://www.landfire.gov/sites/default/files/CSV/2024/LF2024_EVT.csv"
# Existing Vegetation Cover: per-pixel canopy closure, the cross-check against our own lidar CHM
EVC_SERVICE = f"{LF_HOST}/Landfire_{LF_YEAR}/{LF_YEAR}_EVC_CONUS/ImageServer"

FHP = "https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_FHP_TreeSpeciesMetrics_BasalArea/ImageServer"
FHP_YEAR = 2011  # see the traps: 2002 and 2011 must never be mixed
REF_SPECIES = "https://apps.fs.usda.gov/fia/datamart/CSV/REF_SPECIES.csv"
DAYMET = "https://daymet.ornl.gov/single-pixel/api/data"
DAYMET_YEARS = (2014, 2023)  # a ten-year normal; Daymet's single-pixel API is happy with a decade

RES = 30.0  # every source here is a 30 m product; the grid is theirs, not ours

session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"


def _get(url: str, params: dict | None, cache: Path, suffix: str, tries: int = 5, timeout: int = 180) -> bytes:
    """Cache by request hash, back off on the 5xx these shared services answer with under load."""
    key = hashlib.sha1((url + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()[:20]
    hit = cache / f"{key}{suffix}"
    if hit.exists():
        return hit.read_bytes()
    last: Exception | None = None
    for attempt in range(tries):
        try:
            r = session.get(url, params=params, timeout=timeout)
            if r.status_code < 500:
                r.raise_for_status()
                hit.parent.mkdir(parents=True, exist_ok=True)
                hit.write_bytes(r.content)
                return r.content
            last = RuntimeError(f"HTTP {r.status_code}")
        except Exception as exc:  # noqa: BLE001 — every failure here is retryable
            last = exc
        time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def _export_image(service: str, params: dict, cache: Path) -> bytes:
    """ArcGIS exportImage answers with a URL to a file it just wrote; fetch both, cache the TIFF."""
    meta = json.loads(_get(service + "/exportImage", {**params, "f": "json"}, cache, ".json"))
    if "href" not in meta:
        raise RuntimeError(f"{service}: {meta}")
    return _get(meta["href"], None, cache, ".tif")


# --------------------------------------------------------------------------------------------
# reference tables


def evt_table(cache: Path) -> dict[int, dict]:
    """LANDFIRE's own attribute table: VALUE -> name and the lifeform/physiognomy/subclass fields.

    The ImageServer's `rasterAttributeTable` endpoint returns `{}` — the RAT is not published with
    the service — so the class names come from the CSV LANDFIRE ships beside the product. Without
    it a corridor is a histogram of integers.
    """
    raw = _get(EVT_CSV, None, cache / "landfire", ".csv")
    out: dict[int, dict] = {}
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        out[int(r["VALUE"])] = {k: r[k] for k in ("EVT_NAME", "EVT_LF", "EVT_PHYS", "EVT_ORDER", "EVT_CLASS", "EVT_SBCLS", "R", "G", "B")}
    return out


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def ref_species(cache: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """FIA's REF_SPECIES: the species vocabulary, with genus and the softwood/hardwood split.

    Two indexes come out of it. Exact common name — "red spruce" -> Picea rubens, softwood. And the
    LAST word of every common name as a GROUP: "spruce" -> Picea, "oak" -> Quercus, because FIA
    files 10 spruces under Picea and 74 oaks under Quercus. That second index is what lets an EVT
    class NAME be read as species without anybody typing a regional palette — "Acadian Low-Elevation
    Spruce-Fir Forest" tokenises to Picea and Abies because FIA says those are the trees called
    spruce and fir.

    A group word resolves to ONE genus, the one with the most species under it, and only if at
    least three species share the word. Both rules are there because the naive version was wrong in
    two visible ways: "pine" expanded to Pinus *and* Araucaria and Casuarina (4 ornamentals against
    54 real pines) so a corridor's mix listed `pine 0%` twice, and the single species "myrtle of the
    river" made the word "river" a tree group, which put a Calyptranthes in a Maryland oak wood.
    """
    raw = _get(REF_SPECIES, None, cache / "fia", ".csv")
    exact: dict[str, dict] = {}
    words: dict[str, list[dict]] = defaultdict(list)
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
        # SPCD 298/299/998/999 are FIA's "unknown live tree / dead hardwood" placeholders, filed
        # under the genus "Tree". They match the word "hardwood" in an EVT class name and would
        # put a species called `Tree broadleaf` in the mix, so they never enter the vocabulary.
        if r["GENUS"].strip() in ("", "Tree"):
            continue
        rec = {
            "spcd": int(r["SPCD"]),
            "common": r["COMMON_NAME"].strip(),
            "scientific": r["SCIENTIFIC_NAME"].strip(),
            "genus": r["GENUS"].strip(),
            "softwood": r["SFTWD_HRDWD"].strip().upper() == "S",
            "woodland": r["WOODLAND"].strip().upper() == "Y",
        }
        n = _norm(rec["common"])
        exact.setdefault(n, rec)
        if n:
            words[n.split()[-1]].append(rec)
    group: dict[str, dict] = {}
    for word, recs in words.items():
        if len(recs) < 3:
            continue
        by_genus: dict[str, list[dict]] = defaultdict(list)
        for r in recs:
            by_genus[r["genus"]].append(r)
        genus, members = max(by_genus.items(), key=lambda kv: len(kv[1]))
        if len(members) < 3:
            continue
        group[word] = {
            "spcd": None, "common": word, "scientific": f"{genus} spp.", "genus": genus,
            "softwood": sum(m["softwood"] for m in members) * 2 > len(members), "woodland": False,
        }
    return exact, group


# --------------------------------------------------------------------------------------------
# the ground-cover taxonomy, derived from EVT's own fields

#: What a class of ground looks like underfoot. Every branch below is a rule over LANDFIRE's OWN
#: attribute fields — no site, state or region appears anywhere in it, so a new corridor anywhere
#: in the country classifies without anybody adding a row.
GROUND_CLASSES = (
    "mown", "perennial_grass", "annual_grass", "forb", "crop", "marsh",
    "evergreen_scrub", "deciduous_scrub", "mixed_scrub", "dwarf_heath",
    "conifer_duff", "hardwood_litter", "broadleaf_evergreen_litter", "mixed_litter",
    "dune", "ledge", "barren", "water",
)

_LEDGE_WORDS = ("cliff", "canyon", "outcrop", "scree", "talus", "bedrock", "ledge", "badland", "rocky", "lava", "volcanic")
_DUNE_WORDS = ("dune", "sand", "strand", "beach")
_WET_WORDS = ("marsh", "fen", "bog", "wet meadow", "swale", "slough", "tidal", "wetland", "vernal")


def ground_class(a: dict) -> str:
    """One EVT class -> one ground-cover class, from EVT_LF / EVT_SBCLS / EVT_PHYS and the name."""
    lf, phys, sub, name = a["EVT_LF"], a["EVT_PHYS"], a["EVT_SBCLS"].lower(), a["EVT_NAME"].lower()
    if lf == "Water" or "open water" in name:
        return "water"
    if lf == "Developed" or phys.startswith("Developed"):
        # a verge, a median and a lawn: cut grass, whatever the region's wild cover is
        return "mown"
    if lf == "Agriculture" or phys == "Agricultural":
        # pasture and hayland are grass that is cut, row crop is crops.ts's problem
        return "crop" if "crop" in name or "orchard" in name or "vineyard" in name else "perennial_grass"
    if lf in ("Sparse", "Barren", "Snow-Ice"):
        if any(w in name for w in _DUNE_WORDS):
            return "dune"
        if any(w in name for w in _LEDGE_WORDS):
            return "ledge"
        return "barren"
    if lf == "Herb":
        if any(w in name for w in _WET_WORDS):
            return "marsh"
        # "Annual Graminoid/Forb" IS the naturalised Mediterranean annual grassland — wild oat,
        # ripgut brome, foxtail barley — that cures to straw. LANDFIRE separates it from
        # "Perennial graminoid grassland" by hand; we only have to read the field.
        if "annual" in sub:
            return "annual_grass"
        if "forb" in sub:
            return "forb"
        return "perennial_grass"
    if lf == "Shrub":
        if "dwarf" in sub or "dwarf" in a["EVT_CLASS"].lower():
            return "dwarf_heath"
        if sub.startswith("evergreen"):
            return "evergreen_scrub"
        if sub.startswith("deciduous"):
            return "deciduous_scrub"
        return "mixed_scrub"
    if lf == "Tree":
        if sub.startswith("evergreen"):
            return "conifer_duff" if phys in ("Conifer", "Conifer-Hardwood") else "broadleaf_evergreen_litter"
        if sub.startswith("deciduous"):
            return "hardwood_litter"
        return "mixed_litter"
    return "barren"


def leaf_cycle(a: dict) -> str:
    """evergreen / deciduous / mixed for a tree class, straight off EVT_SBCLS."""
    sub = a["EVT_SBCLS"].lower()
    if sub.startswith("evergreen"):
        return "evergreen"
    if sub.startswith("deciduous"):
        return "deciduous"
    if sub.startswith("mixed"):
        return "mixed"
    return "none"


# --------------------------------------------------------------------------------------------
# EVT


def _evt_service(frame: Frame, bbox: tuple[float, float, float, float], cache: Path) -> tuple[str, str]:
    """Which regional EVT mosaic holds this corridor. Asked of the services, not of a state list."""
    lon0, lat0, lon1, lat1 = frame.bbox_wgs(*bbox)
    for region, svc in EVT_SERVICES:
        info = json.loads(_get(svc, {"f": "json"}, cache / "landfire", ".json"))
        ext = info["extent"]
        sr = ext["spatialReference"].get("latestWkid") or ext["spatialReference"]["wkid"]
        from pyproj import Transformer

        tr = Transformer.from_crs(4326, sr, always_xy=True)
        xs, ys = tr.transform([lon0, lon1, lon0, lon1], [lat0, lat0, lat1, lat1])
        if min(xs) >= ext["xmin"] and max(xs) <= ext["xmax"] and min(ys) >= ext["ymin"] and max(ys) <= ext["ymax"]:
            return region, svc
    raise RuntimeError("no LANDFIRE EVT mosaic covers this corridor")


def _grid(bbox: tuple[float, float, float, float]) -> tuple[tuple[float, float, float, float], int, int]:
    """Snap the corridor bbox out to the 30 m lattice the sources are served on."""
    x0 = math.floor(bbox[0] / RES) * RES
    y0 = math.floor(bbox[1] / RES) * RES
    x1 = math.ceil(bbox[2] / RES) * RES
    y1 = math.ceil(bbox[3] / RES) * RES
    return (x0, y0, x1, y1), int(round((x1 - x0) / RES)), int(round((y1 - y0) / RES))


def _read_tif(data: bytes) -> tuple[np.ndarray, "rasterio.Affine"]:
    with MemoryFile(data) as mf, mf.open() as src:
        return src.read(1), src.transform


def evt_grid(frame: Frame, corridor: Polygon, cache: Path) -> dict:
    """The EVT raster over the corridor bbox, on the SITE frame's 30 m lattice, plus the mask of
    pixels actually inside the corridor polygon.

    Asking the service for `imageSR` = the site's UTM zone means the flora grid lines up with every
    other layer in the site directory; nothing downstream sees an Albers metre. Nearest-neighbour,
    because these are class numbers — bilinear on a class raster invents classes.
    """
    bbox, w, h = _grid(corridor.bounds)
    region, svc = _evt_service(frame, bbox, cache)
    data = _export_image(svc, {
        "bbox": "%f,%f,%f,%f" % bbox, "bboxSR": str(frame.epsg), "imageSR": str(frame.epsg),
        "size": f"{w},{h}", "format": "tiff", "pixelType": "S16",
        "interpolation": "RSP_NearestNeighbor", "noDataInterpretation": "esriNoDataMatchAny",
    }, cache / "landfire")
    a, transform = _read_tif(data)
    mask = rasterize([(corridor, 1)], out_shape=a.shape, transform=transform, fill=0, dtype="uint8").astype(bool)
    return {"values": a, "transform": transform, "mask": mask, "bbox": bbox, "size": (w, h), "region": region, "service": svc}


# --------------------------------------------------------------------------------------------
# species


def fhp_catalog(frame: Frame, bbox: tuple[float, float, float, float], cache: Path) -> dict[str, int]:
    """Which species rasters exist over this corridor, and their year.

    The service holds 7017 rasters — one per species per year per FIA production zone — so asking
    for all 340 species everywhere would be 340 requests of which most are outside their zone. A
    SPATIAL catalog query costs one request and names the 45–130 species that have a raster here.
    """
    mx0, my0 = frame.to_merc(bbox[0], bbox[1])
    mx1, my1 = frame.to_merc(bbox[2], bbox[3])
    env = {"xmin": min(mx0, mx1), "ymin": min(my0, my1), "xmax": max(mx0, mx1), "ymax": max(my0, my1), "spatialReference": {"wkid": 102100}}
    found: dict[str, int] = {}
    offset = 0
    while True:
        raw = _get(FHP + "/query", {
            "f": "json", "where": "1=1", "geometry": json.dumps(env), "geometryType": "esriGeometryEnvelope",
            "spatialRel": "esriSpatialRelIntersects", "outFields": "objectid,variable,year",
            "returnGeometry": "false", "resultRecordCount": "1000", "resultOffset": str(offset),
            "orderByFields": "objectid",
        }, cache / "fhp", ".json")
        q = json.loads(raw)
        feats = q.get("features", [])
        for f in feats:
            at = f["attributes"]
            if at["year"] == FHP_YEAR:
                found[at["variable"]] = at["year"]
        if not q.get("exceededTransferLimit") or not feats:
            break
        offset += len(feats)
    return found


#: Genus/aggregate rollups. `spruce_spp` is the sum of every Picea INCLUDING `red_spruce`, so
#: leaving them in double-counts: at Acadia spruce_spp = 15.8 ft²/ac and red_spruce + white_spruce
#: = 15.8 ft²/ac, to the decimal. They only exist in the 2002 slices; dropped anyway, by rule.
_ROLLUP = re.compile(r"(_spp|^other_unknown)")


def fhp_species(frame: Frame, corridor: Polygon, grid: dict, cache: Path) -> dict:
    """Basal area per species over the corridor, as arrays on the EVT lattice.

    One exportImage per species, `multidimensionalDefinition` pinning the variable and the year.
    The obvious cheaper call — `getSamples` with `processAsMultidimensional` — is a trap; see the
    module docstring's companion in docs/corridor/FLORA.md.
    """
    bbox, w, h = _grid(corridor.bounds)
    want = {v: y for v, y in fhp_catalog(frame, bbox, cache).items() if not _ROLLUP.search(v)}
    arrays: dict[str, np.ndarray] = {}
    for var, year in sorted(want.items()):
        mr = json.dumps({"multidimensionalDefinition": [{"variableName": var, "dimensionName": "year", "values": [year]}]})
        data = _export_image(FHP, {
            "bbox": "%f,%f,%f,%f" % bbox, "bboxSR": str(frame.epsg), "imageSR": str(frame.epsg),
            "size": f"{w},{h}", "format": "tiff", "pixelType": "F32",
            "interpolation": "RSP_NearestNeighbor", "mosaicRule": mr,
            "noDataInterpretation": "esriNoDataMatchAny",
        }, cache / "fhp")
        a, _ = _read_tif(data)
        a = np.nan_to_num(a.astype(np.float32), nan=0.0)
        a[a < 0] = 0
        if a.shape != grid["values"].shape:  # the two services rounded the size differently
            a = a[: grid["values"].shape[0], : grid["values"].shape[1]]
            if a.shape != grid["values"].shape:
                continue
        if a[grid["mask"]].sum() > 0:
            arrays[var] = a
        time.sleep(0.1)  # a shared federal service; ~10 req/s is not neighbourly
    return {"arrays": arrays, "requested": len(want), "year": FHP_YEAR}


def species_from_name(name: str, exact: dict, group: dict) -> list[dict]:
    """Read an EVT class name as species, using FIA's vocabulary as the dictionary.

    Longest match wins, so "Sitka Spruce" resolves to Picea sitchensis rather than to every spruce,
    and "Douglas-fir-Western Hemlock" gives Pseudotsuga menziesii and Tsuga heterophylla. A bare
    group word ("Oak", "Pine", "Spruce") expands to the genera FIA files under that word. This is
    the fallback where the basal-area rasters are empty, not the primary source.
    """
    toks = _norm(name.replace("-", " ")).split()
    out: list[dict] = []
    i = 0
    while i < len(toks):
        for span in (3, 2, 1):
            phrase = " ".join(toks[i : i + span])
            if phrase in exact:
                out.append({**exact[phrase], "match": "species"})
                i += span
                break
            if span == 1 and phrase in group:
                out.append({**group[phrase], "match": "group"})
                i += 1
                break
        else:
            i += 1
    return out


# --------------------------------------------------------------------------------------------
# climate


def climate(lat: float, lon: float, cache: Path) -> dict:
    """Monthly rain and temperature normals from Daymet v4 at 1 km.

    Not used to decide WHAT grows — LANDFIRE has already measured that — but WHEN it is green.
    `summer_dry` is June–August rain as a fraction of the year: 0.002 at Bixby Bridge, 0.324 at
    Chesterfield Road. That number drives the curing ramp in the viewer, which is the reason a
    California hillside in the `summer` season is straw and a Maryland one is olive.
    """
    y0, y1 = DAYMET_YEARS
    raw = _get(DAYMET, {"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "vars": "prcp,tmax,tmin",
                        "start": f"{y0}-01-01", "end": f"{y1}-12-31"}, cache / "daymet", ".csv", timeout=300)
    text = raw.decode("utf-8", "replace").splitlines()
    head = next(i for i, l in enumerate(text) if l.startswith("year,"))
    cols = [c.strip() for c in text[head].split(",")]
    ppt = np.zeros(12)
    tmax = np.zeros(12)
    tmin = np.zeros(12)
    days = np.zeros(12)
    years: set[int] = set()
    for line in text[head + 1 :]:
        parts = line.split(",")
        if len(parts) != len(cols):
            continue
        rec = dict(zip(cols, parts))
        yr = int(float(rec["year"]))
        m = (datetime.date(2001, 1, 1) + datetime.timedelta(days=int(float(rec["yday"])) - 1)).month - 1
        years.add(yr)
        ppt[m] += float(rec["prcp (mm/day)"])
        tmax[m] += float(rec["tmax (deg c)"])
        tmin[m] += float(rec["tmin (deg c)"])
        days[m] += 1
    n = max(1, len(years))
    ppt = ppt / n
    annual = float(ppt.sum())
    jja = float(ppt[5:8].sum())
    return {
        "source": "Daymet v4 (ORNL DAAC), 1 km",
        "years": [min(years) if years else None, max(years) if years else None],
        "ppt_mm": [round(float(v), 1) for v in ppt],
        "tmax_c": [round(float(t / max(1, d)), 1) for t, d in zip(tmax, days)],
        "tmin_c": [round(float(t / max(1, d)), 1) for t, d in zip(tmin, days)],
        "annual_mm": round(annual, 1),
        "summer_dry": round(jja / annual, 4) if annual else None,
        "driest_month_mm": round(float(ppt.min()), 1),
        "citation": "Thornton et al. 2022, https://doi.org/10.3334/ORNLDAAC/2129",
    }


# --------------------------------------------------------------------------------------------
# the bake stage


def canopy_heights(site_dir: Path, grid: dict) -> np.ndarray | None:
    """Our own lidar canopy height model, averaged onto the 30 m flora lattice.

    This is the cross-check that stops the species pick from being a guess about size. A species'
    basal area is a weight per pixel; the CHM height under that weight says how tall the trees of
    that species actually are IN THIS CORRIDOR — measured here, by the lidar, not read out of a
    field guide. Where the lidar or the basal area is missing the height is simply null and the
    pick falls back to the mix weights alone.

    Aggregated at the **third quartile**, not the mean. A 30 m LANDFIRE pixel is 900 m² of ground
    and most of it is not a tree top: the mean of the 1 m CHM over that square mixes crowns with
    gaps, verge and pavement, and it came out at 11.5 m for red maple at Acadia where the trees
    the viewer plants from the same CHM stand at 20 m and more. The viewer compares an INDIVIDUAL
    tree's height against this number, so it has to be a canopy height and not a cell average.
    """
    chm = site_dir / "lidar" / "chm.tif"
    if not chm.exists():
        return None
    from rasterio.warp import Resampling, reproject

    with rasterio.open(chm) as src:
        out = np.zeros(grid["values"].shape, np.float32)
        reproject(
            source=rasterio.band(src, 1), destination=out,
            src_transform=src.transform, src_crs=src.crs,
            dst_transform=grid["transform"], dst_crs=src.crs,
            resampling=Resampling.q3, src_nodata=src.nodata, dst_nodata=0.0,
        )
    return np.nan_to_num(out, nan=0.0)


def _mix(weights: dict[str, float], limit: int = 8) -> list[dict]:
    total = sum(weights.values())
    if total <= 0:
        return []
    # a species that rounds to nothing is noise in every consumer: it shows up in the printed mix
    # as `pine 0%` and it can still win a draw. Cut at a thousandth of the stand.
    ranked = [kv for kv in sorted(weights.items(), key=lambda kv: -kv[1])[:limit] if kv[1] / total >= 0.001]
    scale = sum(w for _, w in ranked) or 1.0
    return [{"key": k, "weight": round(w / scale, 4)} for k, w in ranked]


def for_site(site: dict, frame: Frame, corridor: Polygon, cache: Path, out_dir: Path) -> dict:
    table = evt_table(cache)
    exact, group = ref_species(cache)
    grid = evt_grid(frame, corridor, cache)
    values, mask = grid["values"], grid["mask"]
    inside = values[mask]
    total = max(1, inside.size)

    vals, counts = np.unique(inside, return_counts=True)
    order = np.argsort(-counts)
    classes: list[dict] = []
    index: dict[int, int] = {}
    for i in order:
        v = int(vals[i])
        a = table.get(v)
        if a is None:
            continue
        index[v] = len(classes)
        classes.append({
            "value": v,
            "name": a["EVT_NAME"],
            "lifeform": a["EVT_LF"],
            "physiognomy": a["EVT_PHYS"],
            "canopy": a["EVT_CLASS"],
            "subclass": a["EVT_SBCLS"],
            "leaf_cycle": leaf_cycle(a),
            "ground": ground_class(a),
            "share": round(float(counts[i]) / total, 4),
            "rgb": [int(a["R"]), int(a["G"]), int(a["B"])],
        })

    # --- species, per class, measured first and read off the class name second -------------------
    fhp = fhp_species(frame, corridor, grid, cache)
    chm = canopy_heights(out_dir, grid)
    ba_any = np.zeros(values.shape, bool)
    for a in fhp["arrays"].values():
        ba_any |= a > 0
    tree_mask = mask & np.isin(values, [c["value"] for c in classes if c["lifeform"] == "Tree"])
    coverage = float((ba_any & tree_mask).sum()) / max(1, int(tree_mask.sum()))

    species_ref: dict[str, dict] = {}
    height_num: dict[str, float] = defaultdict(float)
    height_den: dict[str, float] = defaultdict(float)

    def note(rec: dict) -> str:
        key = rec["scientific"] or rec["common"]
        species_ref.setdefault(key, {
            "common": rec["common"], "scientific": rec["scientific"], "genus": rec["genus"],
            "softwood": rec["softwood"], "spcd": rec.get("spcd"),
        })
        return key

    site_weights: dict[str, float] = defaultdict(float)
    for c in classes:
        if c["lifeform"] != "Tree":
            continue
        sel = mask & (values == c["value"])
        measured: dict[str, float] = defaultdict(float)
        for var, arr in fhp["arrays"].items():
            s = float(arr[sel].sum())
            if s <= 0:
                continue
            rec = exact.get(_norm(var))
            if rec is None:
                hits = species_from_name(var.replace("_", " "), exact, group)
                if not hits:
                    continue
                rec = hits[0]
            key = note(rec)
            measured[key] += s
            if chm is not None:
                w = arr[sel]
                hh = chm[sel]
                live = (w > 0) & (hh > 2)
                if live.any():
                    height_num[key] += float((w[live] * hh[live]).sum())
                    height_den[key] += float(w[live].sum())
        px_with_ba = int((ba_any & sel).sum())
        if px_with_ba >= 8 and measured:
            c["species"] = _mix(measured)
            c["species_from"] = "fhp"
            c["species_px"] = px_with_ba
        else:
            named = species_from_name(c["name"], exact, group)
            # weight by position in the name: "Spruce-Fir" is spruce first, and a bare group word
            # stands for a genus rather than a species, so it is worth less than a named species
            w: dict[str, float] = defaultdict(float)
            for rank, rec in enumerate(named):
                w[note(rec)] += (1.0 if rec["match"] == "species" else 0.6) / (1 + rank)
            c["species"] = _mix(w)
            c["species_from"] = "evt_name" if named else "none"
            c["species_px"] = px_with_ba
        for s in c["species"]:
            site_weights[s["key"]] += s["weight"] * c["share"]

    ground_weights: dict[str, float] = defaultdict(float)
    for c in classes:
        ground_weights[c["ground"]] += c["share"]

    # --- the class grid, for the viewer ----------------------------------------------------------
    # 8-bit indices into `classes`, 255 = outside the corridor. A corridor is a few hundred by a
    # few thousand metres at 30 m, so this is a few tens of kB; it goes out as a PNG in export.py.
    idx = np.full(values.shape, 255, np.uint8)
    for v, i in index.items():
        if i < 255:
            idx[values == v] = i
    idx[~mask] = 255
    np.save(out_dir / "flora_evt.npy", idx)

    lat, lon = site["lat"], site["lon"]
    clim = climate(lat, lon, cache)

    return {
        "res_m": RES,
        "bbox_utm": [float(v) for v in grid["bbox"]],
        "size": list(grid["size"]),
        "grid": "flora_evt.npy",
        "evt": {
            "source": f"LANDFIRE {LF_YEAR} EVT {grid['region']} (30 m)",
            "service": grid["service"],
            "table": EVT_CSV,
            "credit": "LANDFIRE, USGS/USFS — public domain",
            "classes": classes,
        },
        "canopy": {
            "source": f"USFS FHP tree-species basal area {FHP_YEAR} (30 m, modelled from FIA)",
            "service": FHP,
            "names": REF_SPECIES,
            "rasters_here": fhp["requested"],
            "rasters_with_data": len(fhp["arrays"]),
            "coverage": round(coverage, 4),
            "species": _mix(site_weights, limit=12),
            "ref": {
                k: {**v, "canopy_h_m": round(height_num[k] / height_den[k], 1) if height_den.get(k) else None}
                for k, v in species_ref.items()
            },
        },
        "ground": {"classes": _mix(ground_weights, limit=12), "vocabulary": list(GROUND_CLASSES)},
        "climate": clim,
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def along_spine(spine: LineString, frame: Frame, site: dict, corridor: Polygon, cache: Path, out_dir: Path) -> dict:
    """Entry point matching the other fetch stages' shape."""
    del spine
    out = for_site(site, frame, corridor, cache, out_dir)
    (out_dir / "flora.json").write_text(json.dumps(out, indent=1))
    return out
