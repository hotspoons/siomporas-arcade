"""The tiled path for a big network (cadre §6): rasters clipped to the union corridor and cut into
1 km tiles, so an 18 km region never has to exist as one array.

    lidar/tiles/<x>_<y>.{dtm,dsm,chm,deck_z,deck_n,building_n}.tif   1 m, one per corridor tile
    lidar/{dtm,dsm,chm}.vrt                                            gdalbuildvrt over the tiles
    lidar/corridor.laz                                                 the NEAR-ROAD points only
                                                                       (within BAND_M of any chain)
    naip_1m.tif                                                        1 m, windowed writes, only the
                                                                       4 km service tiles that touch
                                                                       the corridor are fetched
    web/tiles/0/<x>_<y>.dem.png|chm.png|naip.jpg + layers.tiles        main's 011/012 schema

Tile (x, y) covers origin + [x·1000, (x+1)·1000) × [y·1000, (y+1)·1000) in site metres, where
`origin` is the corridor bbox's lower-left snapped to 1 km. Only tiles whose square intersects
the union corridor exist.

WHY TILE-WISE POINTS. Bacon Ridge's 2.6 km² corridor held 13.6 M points; the Crofton region's
30.7 km² would hold ~150 M — 4-5 GB as numpy arrays, on a box other agents share. So each TNM LAZ
delivery tile is read, clipped to the corridor, scattered into the 1 km output tiles' min/max/count
arrays, and dropped. The only points kept are the ones within BAND_M of a road, which is what the
profile's structure test needs (decks within 14 m, spans within 10 m).

WHY A LAZY RASTER. lidar.profile, cuts.measure and friends index `dtm[r, c]` on a numpy array.
`LazyRaster` opens the VRT and answers the same indexing by reading only the rows/cols asked for,
in row bands, so a 16 km branch's transects cost a few hundred MB of reads, not 1.4 GB resident.
"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from scipy import ndimage
from shapely.geometry import LineString, box

from . import lidar
from .geo import Frame

TILE_M = 1000.0
BAND_M = 15.0        # near-road points kept for the structure tests
CHM_MAX = 80.0


class LazyRaster:
    """`arr[rows, cols]` over a rasterio dataset, reading row bands on demand. Also `.shape`."""

    def __init__(self, path: Path, band_rows: int = 1024):
        self.ds = rasterio.open(path)
        self.shape = (self.ds.height, self.ds.width)
        self.transform = self.ds.transform
        self.nodata = self.ds.nodata
        self.band_rows = band_rows

    def __getitem__(self, idx):
        r, c = idx
        r = np.asarray(r, dtype=np.int64)
        c = np.asarray(c, dtype=np.int64)
        scalar = r.ndim == 0
        r = np.atleast_1d(r)
        c = np.atleast_1d(c)
        out = np.full(r.shape, np.nan, np.float32)
        if r.size == 0:
            return out
        for r0 in range(int(r.min()) // self.band_rows * self.band_rows, int(r.max()) + 1, self.band_rows):
            m = (r >= r0) & (r < r0 + self.band_rows)
            if not m.any():
                continue
            c0, c1 = int(c[m].min()), int(c[m].max())
            h = min(self.band_rows, self.shape[0] - r0)
            win = rasterio.windows.Window(c0, r0, c1 - c0 + 1, h)
            a = self.ds.read(1, window=win).astype(np.float32)
            if self.nodata is not None:
                a[a == self.nodata] = np.nan
            out[m] = a[r[m] - r0, c[m] - c0]
        return out[0] if scalar else out

    def close(self):
        self.ds.close()


def tile_index(bbox, corridor) -> tuple[tuple[float, float], list[tuple[int, int]]]:
    """Tile origin (bbox lower-left snapped to 1 km) and the (x, y) tiles intersecting the corridor."""
    x0 = float(np.floor(bbox[0] / TILE_M) * TILE_M)
    y0 = float(np.floor(bbox[1] / TILE_M) * TILE_M)
    nx = int(np.ceil((bbox[2] - x0) / TILE_M))
    ny = int(np.ceil((bbox[3] - y0) / TILE_M))
    tiles = []
    for tx in range(nx):
        for ty in range(ny):
            sq = box(x0 + tx * TILE_M, y0 + ty * TILE_M, x0 + (tx + 1) * TILE_M, y0 + (ty + 1) * TILE_M)
            if sq.intersects(corridor):
                tiles.append((tx, ty))
    return (x0, y0), tiles


def _tnm_tiles(frame: Frame, bbox, cache: Path) -> tuple[str, list[Path]]:
    """TNM LPC tiles of the newest project over the bbox, downloaded (dem.download, cached)."""
    from concurrent.futures import ThreadPoolExecutor

    from .dem import download

    w, s, e, n = frame.bbox_wgs(*bbox)
    r = lidar.session.get(lidar.TNM, params={"datasets": "Lidar Point Cloud (LPC)", "bbox": f"{w},{s},{e},{n}", "outputFormat": "JSON", "max": 800}, timeout=120)
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        raise RuntimeError("no TNM lidar for this region")
    by_proj: dict[str, list[dict]] = {}
    for it in items:
        by_proj.setdefault(" ".join(it["title"].split(" ")[4:-1]), []).append(it)
    proj = max(by_proj, key=lambda k: (max(i.get("publicationDate", "") for i in by_proj[k]), len(by_proj[k])))
    tiles = by_proj[proj]
    total = sum(i.get("sizeInBytes", 0) for i in tiles) / 2**20
    print(f"  lidar   TNM {proj}: {len(tiles)} LAZ tiles, {total:.0f} MiB", flush=True)
    with ThreadPoolExecutor(4) as ex:
        paths = list(ex.map(lambda it: download(it["downloadURL"], cache / "laz" / proj / it["downloadURL"].rsplit("/", 1)[1], it.get("sizeInBytes")), tiles))
    return proj, paths


def lidar_tiled(frame: Frame, bbox, corridor, chains: list[dict], ldir: Path, cache: Path) -> dict:
    """Points → per-tile rasters + near-road corridor.laz. Returns what the manifest records."""
    ldir.mkdir(exist_ok=True)
    tdir = ldir / "tiles"
    tdir.mkdir(exist_ok=True)
    (x0, y0), tiles = tile_index(bbox, corridor)
    n = int(TILE_M)
    acc: dict[tuple[int, int], dict[str, np.ndarray]] = {}
    for t in tiles:
        acc[t] = {"dtm": np.full(n * n, np.inf, np.float32), "dsm": np.full(n * n, -np.inf, np.float32), "veg": np.full(n * n, -np.inf, np.float32), "deck": np.full(n * n, -np.inf, np.float32), "deck_n": np.zeros(n * n, np.uint16), "bld_n": np.zeros(n * n, np.uint16)}
    # the near-road band, at 2 m over the bbox, valued by chain index (+1) so points know their road
    bw = int(np.ceil((bbox[2] - bbox[0]) / 2.0))
    bh = int(np.ceil((bbox[3] - bbox[1]) / 2.0))
    btr = from_origin(bbox[0], bbox[3], 2.0, 2.0)
    band = rasterize([(c["line"].buffer(BAND_M), i + 1) for i, c in enumerate(chains)], out_shape=(bh, bw), transform=btr, fill=0, dtype=np.int32)
    proj, paths = _tnm_tiles(frame, bbox, cache)
    near_parts: list[dict] = []
    counts = np.zeros(32, np.int64)
    total = 0
    demoted = 0
    zf = 1.0
    for i, pth in enumerate(paths, 1):
        part = lidar._read_laz_tile(pth, frame, bbox, corridor)
        if not part:
            print(f"  lidar   tile {i}/{len(paths)} {pth.name}: outside the corridor", flush=True)
            continue
        cls = part["cls"]
        share17 = float((cls == 17).sum()) / max(1, len(cls))
        if share17 > 0.03:
            part["cls"] = np.where((cls == 17) | (cls == 18), 1, cls).astype(np.uint8)
            demoted += 1
        cls = part["cls"]
        counts += np.bincount(cls, minlength=32)[:32]
        total += len(cls)
        x, y, z = part["x"], part["y"], part["z"]
        tx = np.floor((x - x0) / TILE_M).astype(np.int64)
        ty = np.floor((y - y0) / TILE_M).astype(np.int64)
        col = np.floor(x - x0 - tx * TILE_M).astype(np.int64)
        row = np.floor((ty + 1) * TILE_M - (y - y0)).astype(np.int64)
        ok = (col >= 0) & (col < n) & (row >= 0) & (row < n)
        flat = row * n + col
        key = tx * 100000 + ty
        for k in np.unique(key[ok]):
            t = (int(k // 100000), int(k % 100000))
            a = acc.get(t)
            if a is None:
                continue
            m = ok & (key == k)
            f = flat[m]
            zz = z[m].astype(np.float32)
            c = cls[m]
            g = c == 2
            np.minimum.at(a["dtm"], f[g], zz[g])
            np.maximum.at(a["dsm"], f, zz)
            veg = ((c >= 3) & (c <= 5)) | (c == 1)
            np.maximum.at(a["veg"], f[veg], zz[veg])
            d = c == 17
            if d.any():
                np.maximum.at(a["deck"], f[d], zz[d])
                a["deck_n"] += np.bincount(f[d], minlength=n * n).astype(np.uint16)
            b = c == 6
            if b.any():
                a["bld_n"] += np.bincount(f[b], minlength=n * n).astype(np.uint16)
        # keep the near-road points (all classes) for the structure tests
        br = np.clip(((bbox[3] - y) / 2.0).astype(np.int64), 0, bh - 1)
        bc = np.clip(((x - bbox[0]) / 2.0).astype(np.int64), 0, bw - 1)
        road = band[br, bc]
        keep = road > 0
        if keep.any():
            near_parts.append({k2: v[keep] for k2, v in part.items()} | {"road": road[keep].astype(np.int16)})
        print(f"  lidar   tile {i}/{len(paths)} {pth.name}: {len(cls):,} pts in corridor, {int(keep.sum()):,} near a road", flush=True)
        del part
    # write the tiles
    crs = frame.crs
    written = []
    for (tx, ty), a in acc.items():
        dtm = a["dtm"].reshape(n, n)
        dtm[~np.isfinite(dtm)] = np.nan
        if np.isnan(dtm).all():
            continue
        dsm = a["dsm"].reshape(n, n)
        dsm[~np.isfinite(dsm)] = np.nan
        veg = a["veg"].reshape(n, n)
        filled = lidar._fill_nan(dtm.copy())
        chm = np.clip(np.nan_to_num(veg - filled, nan=0.0, neginf=0.0), 0, CHM_MAX).astype(np.float32)
        deck_n = a["deck_n"].reshape(n, n)
        chm[deck_n > 0] = 0
        deck = a["deck"].reshape(n, n)
        deck[~np.isfinite(deck)] = np.nan
        tr = from_origin(x0 + tx * TILE_M, y0 + (ty + 1) * TILE_M, 1.0, 1.0)
        stem = tdir / f"{tx}_{ty}"
        lidar._write(Path(f"{stem}.dtm.tif"), np.nan_to_num(dtm, nan=-9999).astype(np.float32), tr, crs, -9999)
        lidar._write(Path(f"{stem}.dsm.tif"), np.nan_to_num(dsm, nan=-9999).astype(np.float32), tr, crs, -9999)
        lidar._write(Path(f"{stem}.chm.tif"), chm, tr, crs)
        lidar._write(Path(f"{stem}.deck_z.tif"), np.nan_to_num(deck, nan=-9999).astype(np.float32), tr, crs, -9999)
        lidar._write(Path(f"{stem}.deck_n.tif"), deck_n, tr, crs)
        lidar._write(Path(f"{stem}.building_n.tif"), a["bld_n"].reshape(n, n), tr, crs)
        written.append((tx, ty))
    for kind in ("dtm", "dsm", "chm", "deck_z", "deck_n", "building_n"):
        files = [str(tdir / f"{tx}_{ty}.{kind}.tif") for tx, ty in written]
        if files:
            subprocess.run(["gdalbuildvrt", "-q", "-overwrite", str(ldir / f"{kind}.vrt"), *files], check=True)
    # the near-road cloud
    pts = {k: np.concatenate([p[k] for p in near_parts]) for k in near_parts[0]} if near_parts else None
    if pts is not None:
        import laspy
        import pyproj

        las = laspy.create(point_format=6, file_version="1.4")
        las.header.offsets = [float(np.floor(pts["x"].min())), float(np.floor(pts["y"].min())), 0.0]
        las.header.scales = [0.01, 0.01, 0.01]
        las.x, las.y, las.z = pts["x"], pts["y"], pts["z"]
        las.classification = pts["cls"]
        las.return_number, las.number_of_returns, las.intensity = pts["rn"], pts["nr"], pts["i"]
        las.header.add_crs(pyproj.CRS.from_user_input(crs))
        las.write(ldir / "corridor.laz")
    classes = {lidar.CLASS_NAMES.get(i, str(i)): int(c) for i, c in enumerate(counts) if c}
    return {"dataset": f"TNM:{proj}", "tiles_laz": len(paths), "points_in_corridor": int(total), "near_road_points": int(len(pts["x"])) if pts else 0, "classes": classes, "classification": {"tiles_demoted_17_18": demoted, "class17_trusted": demoted == 0}, "z_factor": zf, "tiles": {"size_m": TILE_M, "origin": [x0, y0], "list": written}, "rasters": ["tiles/*.dtm.tif", "tiles/*.dsm.tif", "tiles/*.chm.tif", "dtm.vrt", "dsm.vrt", "chm.vrt"], "pts": pts}


def naip_tiled(frame: Frame, bbox, corridor, out: Path, cache: Path, res: float = 1.0) -> dict:
    """NAIP at `res` m over the bbox, only the service tiles that touch the corridor, written
    window by window into one JPEG-compressed GeoTIFF."""
    from io import BytesIO

    from PIL import Image

    from .naip import SERVICE, TILE_PX, _get_with_retry, session  # noqa: F401

    if out.exists():
        return {"file": out.name, "cached": True, "res_m": res}
    xmin, ymin, xmax, ymax = bbox
    width = int(round((xmax - xmin) / res))
    height = int(round((ymax - ymin) / res))
    tiles = [(r0, c0) for r0 in range(0, height, TILE_PX) for c0 in range(0, width, TILE_PX)]
    fetched = 0
    with rasterio.open(out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=frame.crs, transform=from_origin(xmin, ymax, res, res), compress="jpeg", photometric="ycbcr", tiled=True, blockxsize=512, blockysize=512, jpeg_quality=88) as dst:
        for i, (r0, c0) in enumerate(tiles, 1):
            tw, th = min(TILE_PX, width - c0), min(TILE_PX, height - r0)
            bx0, by1 = xmin + c0 * res, ymax - r0 * res
            if not box(bx0, by1 - th * res, bx0 + tw * res, by1).intersects(corridor):
                continue
            hit = cache / "naip" / f"{frame.epsg}_{bx0:.1f}_{by1:.1f}_{tw}x{th}_{res:g}.jpg"
            if hit.exists():
                raw = hit.read_bytes()
            else:
                r = _get_with_retry(SERVICE, params={"bbox": f"{bx0},{by1 - th * res},{bx0 + tw * res},{by1}", "bboxSR": frame.epsg, "imageSR": frame.epsg, "size": f"{tw},{th}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image"}, timeout=300)
                r.raise_for_status()
                if not r.headers.get("content-type", "").startswith("image"):
                    raise RuntimeError(f"NAIP exportImage returned {r.headers.get('content-type')}: {r.text[:200]}")
                raw = r.content
                hit.parent.mkdir(parents=True, exist_ok=True)
                hit.write_bytes(raw)
            tile = np.asarray(Image.open(BytesIO(raw)).convert("RGB"))
            dst.write(np.moveaxis(tile, -1, 0), window=rasterio.windows.Window(c0, r0, tw, th))
            fetched += 1
            print(f"  naip    tile {i}/{len(tiles)} ({fetched} fetched)", flush=True)
    return {"file": out.name, "res_m": res, "size": [width, height], "tiles_fetched": fetched}


def export_tiles(site_dir: Path, web: Path, ox: float, oy: float, mask_shapes: list, vivid) -> dict:
    """web/tiles/0/<x>_<y>.dem.png|chm.png|naip.jpg for every corridor tile; returns layers.tiles."""
    from PIL import Image
    from rasterio.enums import Resampling

    from .export import _encode_height, _fill

    lidar_meta = json.loads((site_dir / "manifest.json").read_text()).get("lidar", {}) if (site_dir / "manifest.json").exists() else {}
    tinfo = lidar_meta.get("tiles") or {}
    x0, y0 = tinfo.get("origin", [None, None])
    tiles = [tuple(t) for t in tinfo.get("list", [])]
    if x0 is None or not tiles:
        return {}
    tdir = web / "tiles" / "0"
    tdir.mkdir(parents=True, exist_ok=True)
    n = int(TILE_M)
    dem_p = site_dir / "dem_1m.tif"
    chm_p = site_dir / "lidar" / "chm.vrt"
    naip_p = site_dir / "naip_1m.tif"
    entries = []
    dem_ds = rasterio.open(dem_p) if dem_p.exists() else None
    chm_ds = rasterio.open(chm_p) if chm_p.exists() else None
    naip_ds = rasterio.open(naip_p) if naip_p.exists() else None
    for tx, ty in tiles:
        bx0, by0 = x0 + tx * TILE_M, y0 + ty * TILE_M
        bx1, by1 = bx0 + TILE_M, by0 + TILE_M
        entry: dict = {"x": tx, "y": ty}
        if dem_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=dem_ds.transform)
            z = dem_ds.read(1, window=win, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=-9999).astype(np.float32)
            z = _fill(z, -9999)
            if not np.isfinite(z).any():
                continue
            rgb, zmin, scale = _encode_height(z)
            Image.fromarray(rgb, "RGB").save(tdir / f"{tx}_{ty}.dem.png", optimize=True)
            entry["dem"] = {"zmin": zmin, "zscale": scale}
        if chm_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=chm_ds.transform)
            c = chm_ds.read(1, window=win, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
            c = np.nan_to_num(c, nan=0.0)
            if mask_shapes:
                tr2 = from_origin(bx0, by1, 2.0, 2.0)
                sub = [(g, 1) for g in mask_shapes if g.intersects(box(bx0, by0, bx1, by1))]
                if sub:
                    m = rasterize(sub, out_shape=c.shape, transform=tr2, fill=0, dtype=np.uint8).astype(bool)
                    c[m] = 0.0
            Image.fromarray(np.clip(np.round(c * 4), 0, 255).astype(np.uint8), "L").save(tdir / f"{tx}_{ty}.chm.png", optimize=True)
            entry["chm"] = True
        if naip_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=naip_ds.transform)
            rgb = naip_ds.read(out_shape=(3, n, n), window=win, resampling=Resampling.average, boundless=True, fill_value=0)
            img = vivid(Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB"), 1.3, 1.1)
            r_, g_, b_ = img.split()
            img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
            img.save(tdir / f"{tx}_{ty}.naip.jpg", quality=85, optimize=True)
            entry["naip"] = True
        entries.append(entry)
    for ds in (dem_ds, chm_ds, naip_ds):
        if ds is not None:
            ds.close()
    return {"size_m": TILE_M, "origin": [x0 - ox, y0 - oy], "res": {"dem": 2.0, "naip": 1.0, "chm": 2.0}, "dir": "tiles/0", "list": entries}


def mask_shapes(site_dir: Path, derived: dict) -> list:
    """Canopy mask for the tiles: every carriageway (paved width + 2 m) and every building ring,
    the same rule export.py applies to a single-image chm."""
    from shapely.geometry import Polygon

    site = json.loads((site_dir / "site.json").read_text())
    ox, oy = site["frame"]["origin"]
    sp0 = json.loads((site_dir / "spine_utm.json").read_text())
    shapes = []
    lanes_max = 2
    for seg in sp0.get("segments", []):
        try:
            lanes_max = max(lanes_max, int(seg["tags"].get("lanes", 2)))
        except ValueError:
            pass
    half = (lanes_max * 3.66 + 4.2) / 2 + 2.0
    shapes.append(LineString(sp0["coords"]).buffer(half, cap_style="flat"))
    for sib in sp0.get("siblings", []):
        gg = sib["geometry"]
        parts = [gg["coordinates"]] if gg["type"] == "LineString" else gg["coordinates"]
        try:
            ln = int(str(sib.get("lanes") or 2).split(",")[0].strip("[]' "))
        except ValueError:
            ln = 2
        h2 = (max(2, ln) * 3.66 + 4.2) / 2 + 2.0
        for part in parts:
            if len(part) > 1:
                shapes.append(LineString(part).buffer(h2, cap_style="flat"))
    for b in derived.get("buildings", []):
        ring = b.get("ring") or []
        if len(ring) >= 3:
            shapes.append(Polygon([(x + ox, y + oy) for x, y in ring]).buffer(1.0))
    return shapes


def profile_tiled(line: LineString, ldir: Path, pts: dict | None, road_index: int | None = None) -> dict:
    """lidar.profile over the VRTs with a LazyRaster, and only this road's near points."""
    dtm = LazyRaster(ldir / "dtm.vrt")
    chm = LazyRaster(ldir / "chm.vrt")
    try:
        if pts is None:
            sub = {"x": np.zeros(0), "y": np.zeros(0), "z": np.zeros(0), "cls": np.zeros(0, np.uint8), "rn": np.zeros(0, np.uint8), "nr": np.zeros(0, np.uint8), "i": np.zeros(0, np.uint16)}
        elif road_index is not None and "road" in pts:
            m = pts["road"] == road_index
            sub = {k: v[m] for k, v in pts.items() if k != "road"}
        else:
            sub = {k: v for k, v in pts.items() if k != "road"}
        return lidar.profile(line, dtm, chm, dtm.transform, sub)
    finally:
        dtm.close()
        chm.close()


def elapsed(t0: float) -> str:
    return f"{time.time() - t0:.0f} s"
