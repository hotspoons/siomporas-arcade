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

import io
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
# NAIP is 0.6 m in Maryland (0.3 in some states) and the tiles were cut at 1 m, throwing away 2.8x
# the pixels the fetch had already paid for — Rich: "the satellite imagery in my home town seems
# really low res" (2026-09-26). The fetch asks for this and the tile export cuts at the source's
# own resolution, rounded to a multiple of four pixels for the KTX2 encoder.
NAIP_RES_M = 0.6
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

    from . import naip as naip_mod
    from .naip import SERVICE, TILE_PX, _get_with_retry, session  # noqa: F401

    if out.exists():
        return {"file": out.name, "cached": True, "res_m": res}
    # OUTSIDE THE UNITED STATES THERE IS NO NAIP, and the service does not say so — it answers
    # HTTP 200 with a black JPEG, tile after tile. The first Stelvio bake came out with a
    # 6830x3450 image containing exactly one colour and a completely green log. `naip.covered`
    # probes for CONTENT rather than for a status code; see its docstring for the two measurements
    # that prove it can tell the difference.
    if not naip_mod.covered(frame, bbox):
        return naip_mod.fetch_sentinel2(frame, bbox, out, res=res)
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


def export_tiles(site_dir: Path, web: Path, frame, mask_shapes: list, vivid) -> dict:
    """
    One pack + one texture per tile: web/tiles/0/<x>_<y>.pack and <x>_<y>.naip.jpg.

    The pack holds the DATA rasters (dem, chm) in the trailworks container — see pack.py for the
    format and why the texture stays a separate object. Each entry also carries `geo`, the
    geodetic control lattice that puts the tile on the ellipsoid: a tile is a regular grid on the
    UTM plane, and in ENU that grid is rotated by the meridian convergence and curved. 3x3 over a
    1 km tile is well under a centimetre (bilinear error scales with the square of the span, and
    9x9 over a whole 8.5 km site measured 18 mm).
    """
    from PIL import Image
    from rasterio.enums import Resampling

    from .export import _encode_height, _fill
    from .pack import write_pack

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
    rev = int((site_dir / "manifest.json").stat().st_mtime) if (site_dir / "manifest.json").exists() else 0
    dem_ds = rasterio.open(dem_p) if dem_p.exists() else None
    chm_ds = rasterio.open(chm_p) if chm_p.exists() else None
    naip_ds = rasterio.open(naip_p) if naip_p.exists() else None
    for tx, ty in tiles:
        bx0, by0 = x0 + tx * TILE_M, y0 + ty * TILE_M
        bx1, by1 = bx0 + TILE_M, by0 + TILE_M
        entry: dict = {"x": tx, "y": ty}
        parts: dict[str, bytes] = {}
        if dem_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=dem_ds.transform)
            z = dem_ds.read(1, window=win, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=-9999).astype(np.float32)
            z = _fill(z, -9999)
            if not np.isfinite(z).any():
                continue
            rgb, zmin, scale = _encode_height(z)
            buf = io.BytesIO()
            Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True)
            parts["dem.png"] = buf.getvalue()
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
            buf = io.BytesIO()
            Image.fromarray(np.clip(np.round(c * 4), 0, 255).astype(np.uint8), "L").save(buf, "PNG", optimize=True)
            parts["chm.png"] = buf.getvalue()
            entry["chm"] = True
        if naip_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=naip_ds.transform)
            # the tile at the source's own resolution (a 0.6 m NAIP gives 1668 px, a 1 m one 1000)
            nn = int(round(TILE_M / max(0.25, float(naip_ds.res[0])) / 4.0)) * 4
            rgb = naip_ds.read(out_shape=(3, nn, nn), window=win, resampling=Resampling.average, boundless=True, fill_value=0)
            # A TILE AT THE EDGE OF COVERAGE IS NOT BLACK GROUND. `boundless=True` lets the window
            # run past the source raster and fills whatever it finds outside with 0, and the tile
            # grid is the corridor hull snapped to 1 km — so edge tiles legitimately reach past
            # where NAIP was fetched and came out as black slabs with a dead straight edge exactly
            # where coverage stops.
            #
            # Measured on crofton-triangle before this: 59 tiles with a mean luma of 66.9 and a
            # standard deviation of 14.4, ranging 13.8 to 91.4 — `5_0` at 13.8 sitting directly
            # below `5_1` at 91.4, a 6.6x step across a tile boundary. But 5_0 was 85 % nodata and
            # the imagery it DID have averaged 91.9 against its neighbour's 91.8. The photograph
            # was never the problem.
            #
            # Filling with the tile's own valid mean is not correct at the metre level and is not
            # meant to be — it is a plausible tone where there is no measurement, and the eye reads
            # it as more of the same ground instead of a hole. Exact zero across all three channels
            # is the fill's own signature; real NAIP essentially never is.
            blank = (rgb == 0).all(axis=0)
            nblank = int(blank.sum())
            if nblank and nblank < blank.size:
                for c in range(3):
                    ch = rgb[c]
                    ch[blank] = int(ch[~blank].mean())
                entry["naip_fill"] = round(nblank / blank.size, 3)
            img = vivid(Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB"), 1.3, 1.1)
            r_, g_, b_ = img.split()
            img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
            img.save(tdir / f"{tx}_{ty}.naip.jpg", quality=85, optimize=True)
            entry["naip"] = True
        if not parts:
            continue
        entry["pack"] = write_pack(tdir / f"{tx}_{ty}.pack", parts, rev=rev)
        # where this tile's corners actually are on the ellipsoid
        entry["geo"] = frame.control_lattice((bx0, by0, bx1, by1), 3)
        entries.append(entry)
    naip_res_src = round(float(naip_ds.res[0]), 3) if naip_ds is not None else 1.0
    for ds in (dem_ds, chm_ds, naip_ds):
        if ds is not None:
            ds.close()
    return {
        "size_m": TILE_M,
        # The ENU position of the UTM tile grid's origin. DO NOT walk the grid from it: the tiles
        # step along the UTM axes, which are rotated from ENU by the meridian convergence, so
        # `origin + x * size_m` is not where tile x is. Measured on crofton-crownsville, that
        # arithmetic is out by up to 384.9 m across 125 tiles. `geo` on each entry is the only
        # thing that places a tile; this is for a coarse cull and for debugging, nothing else.
        "origin": [round(float(v), 2) for v in frame.to_enu(x0, y0)],
        "res": {"dem": 2.0, "naip": naip_res_src, "chm": 2.0},
        "dir": "tiles/0",
        "format": "pack-1",
        "texture": "naip.jpg",
        "list": entries,
    }


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


def _fill_along(values: list[float]) -> list[float]:
    """Interpolate non-finite entries along an along-track array (a road's grade is continuous).

    THE BUG THIS FIXES (2026-09-21): the single-image path hands lidar.profile a gap-filled DTM
    (`_fill_nan`), but the tiled path hands it a VRT, and LazyRaster answers nodata with NaN — so a
    station whose 1 m cell is outside the lidar (a road crossing the corridor's own edge, a hole in
    the flight) came back NaN, that NaN went into road_z, into the manifest's branch coords, and
    `json.dump` wrote a literal `NaN` that `JSON.parse` refuses: the whole Crofton site failed to
    load in the browser. Interpolating is also the physically right answer, and matches what the
    single-image path already does to the raster."""
    a = np.asarray(values, dtype=float)
    bad = ~np.isfinite(a)
    if not bad.any():
        return values
    if bad.all():
        return [0.0] * len(values)
    idx = np.flatnonzero(~bad)
    a[bad] = np.interp(np.flatnonzero(bad), idx, a[idx])
    return [round(float(v), 2) for v in a]


def _fill_profile(prof: dict) -> dict:
    """Every along-track array in a profile, gap-filled. Structures carry no raster samples."""
    for key in ("road_z", "ground_z"):
        if key in prof:
            prof[key] = _fill_along(prof[key])
    for group in ("ground_rel", "canopy"):
        if group in prof:
            prof[group] = {k: _fill_along(v) for k, v in prof[group].items()}
    return prof


def _raster(ldir: Path, kind: str) -> Path:
    """The VRT of a tiled bake, or the single GeoTIFF of a small one. LazyRaster reads either."""
    vrt = ldir / f"{kind}.vrt"
    return vrt if vrt.exists() else ldir / f"{kind}.tif"


def profile_tiled(line: LineString, ldir: Path, pts: dict | None, road_index: int | None = None) -> dict:
    """lidar.profile over the rasters with a LazyRaster, and only this road's near points."""
    dtm = LazyRaster(_raster(ldir, "dtm"))
    chm = LazyRaster(_raster(ldir, "chm"))
    try:
        if pts is None:
            sub = {"x": np.zeros(0), "y": np.zeros(0), "z": np.zeros(0), "cls": np.zeros(0, np.uint8), "rn": np.zeros(0, np.uint8), "nr": np.zeros(0, np.uint8), "i": np.zeros(0, np.uint16)}
        elif road_index is not None and "road" in pts:
            m = pts["road"] == road_index
            sub = {k: v[m] for k, v in pts.items() if k != "road"}
        else:
            sub = {k: v for k, v in pts.items() if k != "road"}
        return _fill_profile(lidar.profile(line, dtm, chm, dtm.transform, sub))
    finally:
        dtm.close()
        chm.close()


def elapsed(t0: float) -> str:
    return f"{time.time() - t0:.0f} s"


def reprofile(site_dir: Path) -> dict:
    """Re-run the primary's and every branch's profile from the rasters already on disk.

    The expensive half of a tiled bake is the download and the point pass (Crofton: 199 LAZ tiles,
    500 M points, 8.7 h); the profiles are minutes. So a rule change downstream of the rasters —
    the NaN fill above, a new structure test — re-runs this instead of the bake. Inputs: the VRTs,
    `lidar/corridor.laz` (the near-road points), and `spine_utm.json` (the chains). The road index
    each point belongs to is recomputed exactly as the bake did it, by rasterizing the chain band.
    """
    import laspy
    from shapely.geometry import LineString as LS

    ldir = site_dir / "lidar"
    spine = json.loads((site_dir / "spine_utm.json").read_text())
    if not spine.get("network"):
        raise SystemExit(f"{site_dir.name} is not a network site")
    chains: list[dict] = [{"id": (spine.get("primary") or {}).get("id", "r00"), "line": LS(spine["coords"]), "primary": True}]
    for sib in spine.get("siblings", []):
        g = sib["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        coords = [c for part in parts for c in part]
        if len(coords) >= 2:
            chains.append({"id": sib.get("id"), "line": LS(coords), "primary": False, "sib": sib})
    las = laspy.read(ldir / "corridor.laz")
    pts = {"x": np.asarray(las.x), "y": np.asarray(las.y), "z": np.asarray(las.z), "cls": np.asarray(las.classification).astype(np.uint8), "rn": np.asarray(las.return_number).astype(np.uint8), "nr": np.asarray(las.number_of_returns).astype(np.uint8), "i": np.asarray(las.intensity).astype(np.uint16)}
    xmin, ymin = float(pts["x"].min()) - 50, float(pts["y"].min()) - 50
    xmax, ymax = float(pts["x"].max()) + 50, float(pts["y"].max()) + 50
    bw, bh = int(np.ceil((xmax - xmin) / 2.0)), int(np.ceil((ymax - ymin) / 2.0))
    btr = from_origin(xmin, ymax, 2.0, 2.0)
    band = rasterize([(c["line"].buffer(BAND_M), i + 1) for i, c in enumerate(chains)], out_shape=(bh, bw), transform=btr, fill=0, dtype=np.int32)
    br = np.clip(((ymax - pts["y"]) / 2.0).astype(np.int64), 0, bh - 1)
    bc = np.clip(((pts["x"] - xmin) / 2.0).astype(np.int64), 0, bw - 1)
    pts["road"] = band[br, bc].astype(np.int16)
    print(f"  reprofile {len(pts['x']):,} near-road points, {len(chains)} chains", flush=True)
    # defensive on the READ as well as the write: a branches.json from a run that crashed part-way
    # can hold records with no id, and re-profiling is exactly how you recover from that
    branches_old: dict[str, dict] = {}
    if (site_dir / "branches.json").exists():
        try:
            for b in json.loads((site_dir / "branches.json").read_text()).get("branches", []):
                if b.get("id"):
                    branches_old[b["id"]] = b
        except Exception as exc:
            print(f"  reprofile ignoring unreadable branches.json ({exc})", flush=True)
    branches = []
    for i, c in enumerate(chains):
        prof = profile_tiled(c["line"], ldir, pts, i + 1)
        if c["primary"]:
            (site_dir / "profile.json").write_text(json.dumps(prof))
            print(f"  reprofile primary {c['id']}: {len(prof['structures'])} structures", flush=True)
            continue
        # The record is rebuilt from the SIBLING in spine_utm.json, which is authoritative after a
        # revector — matching the previous branches.json by id silently produced records with no
        # id or ident at all the first time the ids changed shape, and the export then died on
        # KeyError 'id'. Anything the old record had and the sibling does not (nothing today) is
        # carried over, never the other way round.
        sib = c["sib"]
        old = branches_old.get(c["id"], {})
        branches.append({
            **old,
            "id": sib["id"], "ident": sib.get("ident"), "name": sib.get("name"), "ref": sib.get("ref"),
            "highway": sib.get("highway"), "lanes": sib.get("lanes"), "oneway": sib.get("oneway"),
            "length_m": sib.get("length_m"), "junctions": sib.get("junctions") or [],
            "dead_ends": sib.get("dead_ends") or [],
            "s_on_primary": old.get("s_on_primary") if old.get("s_on_primary") is not None else round(float(chains[0]["line"].project(c["line"].interpolate(0.5, normalized=True))), 1),
            "profile": {"step_m": prof["step_m"], "s": prof["s"], "road_z": prof["road_z"]},
            "structures": prof["structures"],
        })
    (site_dir / "branches.json").write_text(json.dumps({"frame": "enu", "branches": branches}))
    print(f"  reprofile {len(branches)} branches, {sum(len(b['structures']) for b in branches)} structures", flush=True)
    return {"chains": len(chains), "branches": len(branches)}


def reprofile_from_dtm(site_dir: Path, step_m: float = 2.0) -> dict:
    """Branch profiles from the DTM alone, for a box that cannot hold the point cloud.

    `reprofile` above rebuilds every branch from the near-road points and the full structure test,
    and needs the machine to itself: crofton-triangle's 72.6 M returns were OOM-killed with 5 GB
    free (2026-09-26). A residential street's driving surface IS the ground in the lidar DTM to
    within centimetres, so sampling `lidar/dtm.vrt` every `step_m` along each chain gives the
    same road_z for grading without touching the points. No structures — a side street's
    overpasses are not found this way, and the primary keeps its own profile.json. Falls back to
    the 1 m DEM where the DTM is nodata (the band-limited rasters stop at the lidar corridor).
    """
    import rasterio
    from shapely.geometry import LineString as LS

    spine = json.loads((site_dir / "spine_utm.json").read_text())
    if not spine.get("network"):
        raise SystemExit(f"{site_dir.name} is not a network site")
    dtm = rasterio.open(site_dir / "lidar" / "dtm.vrt")
    dem_p = site_dir / "dem_1m.tif"
    dem = rasterio.open(dem_p) if dem_p.exists() else None
    branches_old: dict[str, dict] = {}
    if (site_dir / "branches.json").exists():
        for b in json.loads((site_dir / "branches.json").read_text()).get("branches", []):
            if b.get("id"):
                branches_old[b["id"]] = b
    prim = LS(spine["coords"])
    branches = []
    filled = 0
    for sib in spine.get("siblings", []):
        g = sib["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        coords = [c for part in parts for c in part]
        if len(coords) < 2:
            continue
        line = LS(coords)
        s = np.arange(0.0, line.length, step_m).tolist() + [line.length]
        xy = [line.interpolate(v).coords[0] for v in s]
        z = np.array([v[0] for v in dtm.sample(xy)], dtype=float)
        bad = ~np.isfinite(z) | (z == (dtm.nodata if dtm.nodata is not None else -9999)) | (z < -100)
        if bad.any() and dem is not None:
            zd = np.array([v[0] for v in dem.sample([xy[i] for i in np.flatnonzero(bad)])], dtype=float)
            z[bad] = zd
            filled += int(bad.sum())
        bad = ~np.isfinite(z) | (z < -100)
        if bad.any():
            good = ~bad
            z[bad] = np.interp(np.flatnonzero(bad), np.flatnonzero(good), z[good]) if good.any() else 0.0
        # a light smoothing, the same spirit as the bake's station clamp: a DTM has kerbs and cars in it
        if len(z) >= 5:
            k = np.array([1, 2, 3, 2, 1], float) / 9.0
            zp = np.pad(z, 2, mode="edge")
            z = np.convolve(zp, k, mode="valid")
        old = branches_old.get(sib.get("id"), {})
        branches.append({
            **old,
            "id": sib["id"], "ident": sib.get("ident"), "name": sib.get("name"), "ref": sib.get("ref"),
            "highway": sib.get("highway"), "lanes": sib.get("lanes"), "oneway": sib.get("oneway"),
            "length_m": sib.get("length_m"), "junctions": sib.get("junctions") or [],
            "dead_ends": sib.get("dead_ends") or [],
            "s_on_primary": old.get("s_on_primary") if old.get("s_on_primary") is not None else round(float(prim.project(line.interpolate(0.5, normalized=True))), 1),
            "profile": {"step_m": step_m, "s": [round(float(v), 1) for v in s], "road_z": [round(float(v), 2) for v in z], "source": "dtm"},
            "structures": old.get("structures") or [],
        })
    dtm.close()
    if dem is not None:
        dem.close()
    (site_dir / "branches.json").write_text(json.dumps({"frame": "enu", "branches": branches}))
    print(f"  reprofile(dtm) {len(branches)} branches from the DTM, {filled} samples filled from the DEM", flush=True)
    return {"branches": len(branches), "filled": filled}


def main() -> None:
    import sys

    from .__main__ import DATA

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    from_dtm = "--dtm" in sys.argv
    for slug in args:
        print(f"=== {slug}")
        (reprofile_from_dtm if from_dtm else reprofile)(DATA / "sites" / slug)


if __name__ == "__main__":
    main()


OVERVIEW_DEM_M = 8.0
# The imagery goes on as ONE texture, and 4096 px is the limit a lot of GPUs still report — over it
# the upload fails and the terrain draws untextured. So the overview resolution is chosen to keep
# the long side under that for the extent at hand, rather than fixed: an 18.8 km region at 4 m is
# 4702 px and would be over.
OVERVIEW_MAX_PX = 4000


def overview(site_dir: Path, web: Path, frame, mask_shapes: list, vivid) -> dict:
    """A whole-region dem/chm/naip at coarse resolution, so a tiled site LOADS.

    The tiles are the right answer and the viewer will stream them, but until it does, a site whose
    only height layer is `layers.tiles` fails outright — `scene.ts` raises "site has no DEM layer"
    and you get nothing at all (Rich, 2026-09-21, on crofton-crownsville). One overview at 8 m is
    5.4 M pixels for an 18 km region, which decodes in a browser without complaint, and it is only
    the FAR terrain: within 40 m of any road the corridor strip is built from the carriageway
    spline, so the road you drive on is unaffected by the coarseness. Whoever wires tile streaming
    should prefer `layers.tiles` when it is present and treat these as the fallback.
    """
    from PIL import Image
    from rasterio.enums import Resampling

    from .export import _encode_height, _fill
    from .pack import write_pack

    layers: dict = {}
    site = json.loads((site_dir / "site.json").read_text())
    bbox = tuple(site["bbox_utm"])

    def rel(b):
        from .export import _enu_bbox

        return _enu_bbox(frame, b)

    def read(path: Path, res: float, count: int = 1):
        with rasterio.open(path) as src:
            w = int(round((bbox[2] - bbox[0]) / res))
            h = int(round((bbox[3] - bbox[1]) / res))
            win = rasterio.windows.from_bounds(*bbox, transform=src.transform)
            a = src.read(out_shape=(count, h, w), window=win, resampling=Resampling.average, boundless=True, fill_value=src.nodata if src.nodata is not None and count == 1 else 0)
        return (a[0] if count == 1 else a), (w, h)

    dem_p = site_dir / "dem_1m.tif"
    if dem_p.exists():
        z, (w, h) = read(dem_p, OVERVIEW_DEM_M)
        z = _fill(z.astype(np.float32), -9999)
        rgb, zmin, scale = _encode_height(z)
        Image.fromarray(rgb, "RGB").save(web / "dem_8m.png", optimize=True)
        layers["dem"] = {"file": "dem_8m.png", "res": OVERVIEW_DEM_M, "size": [w, h], "bbox": rel(bbox), "geo": frame.control_lattice(bbox), "zmin": zmin, "zscale": scale, "overview": True}

    chm_p = _raster(site_dir / "lidar", "chm")
    if chm_p.exists() and "dem" in layers:
        c, (w, h) = read(chm_p, OVERVIEW_DEM_M)
        c = np.nan_to_num(c.astype(np.float32), nan=0.0)
        if mask_shapes:
            tr = from_origin(bbox[0], bbox[3], OVERVIEW_DEM_M, OVERVIEW_DEM_M)
            c[rasterize([(g, 1) for g in mask_shapes], out_shape=c.shape, transform=tr, fill=0, dtype=np.uint8).astype(bool)] = 0.0
        Image.fromarray(np.clip(np.round(c * 4), 0, 255).astype(np.uint8), "L").save(web / "chm_8m.png", optimize=True)
        layers["chm"] = {"file": "chm_8m.png", "res": OVERVIEW_DEM_M, "size": [w, h], "bbox": rel(bbox), "geo": frame.control_lattice(bbox), "scale": 0.25, "overview": True}

    naip_p = site_dir / "naip_1m.tif"
    if naip_p.exists():
        span = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
        naip_res = max(1.0, round(span / OVERVIEW_MAX_PX, 1))
        rgb, (w, h) = read(naip_p, naip_res, count=3)
        img = vivid(Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB"), 1.3, 1.1)
        r_, g_, b_ = img.split()
        img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
        img.save(web / "naip_overview.jpg", quality=85, optimize=True)
        layers["naip"] = {"file": "naip_overview.jpg", "res": naip_res, "size": [w, h], "bbox": rel(bbox), "geo": frame.control_lattice(bbox), "overview": True}
    return layers


def ensure_overview(site_dir: Path) -> dict | None:
    """Write the overview layers and patch them into an existing manifest, without a full export.

    A tiled site whose manifest lists only `layers.tiles` does not load — `scene.ts` raises "site
    has no DEM layer". A full re-export fixes it but re-renders 125 tiles for ten minutes, and the
    manifest can be regenerated without these layers by anyone running an export from a checkout
    that lacks `overview()` (which happened to crofton twice in one hour). This is the ten-second
    repair: build the images if they are missing, merge the three layer entries into the manifest
    on disk, leave everything else exactly as it was.

        python -m corridor.overview <slug> [...]
    """
    web = site_dir / "web"
    man = web / "manifest.json"
    if not man.exists():
        print(f"{site_dir.name}: no web/manifest.json")
        return None
    m = json.loads(man.read_text())
    if not (m.get("layers") or {}).get("tiles"):
        print(f"{site_dir.name}: not a tiled site, nothing to do")
        return None
    from PIL import ImageEnhance

    from . import buildings as bld

    site = json.loads((site_dir / "site.json").read_text())
    ox, oy = site["frame"]["origin"]

    def vivid(img, sat, con, green=1.0):
        """The same push export.py gives the drape: NAIP is flown for measurement and reads grey."""
        img = ImageEnhance.Color(img).enhance(sat)
        img = ImageEnhance.Contrast(img).enhance(con)
        if green != 1.0:
            r, g, b = img.split()
            img = Image.merge("RGB", (r, g.point(lambda v: min(255, int(v * green))), b))
        return img

    try:
        derived = bld.derive(site_dir)
    except Exception as exc:
        print(f"  buildings failed ({exc}); masking the canopy with the roads only")
        derived = {"buildings": []}
    ov = overview(site_dir, web, ox, oy, mask_shapes(site_dir, derived), vivid)
    if not ov:
        print(f"{site_dir.name}: nothing to build")
        return None
    m.setdefault("layers", {}).update(ov)
    man.write_text(json.dumps(m))
    print(f"{site_dir.name}: layers now {sorted(m['layers'])} — " + ", ".join(f"{k} {v['size'][0]}x{v['size'][1]} @ {v['res']} m" for k, v in ov.items()))
    return ov


def main_overview() -> None:
    import sys

    from .__main__ import DATA

    for slug in sys.argv[1:] or [d.name for d in sorted((DATA / "sites").glob("*")) if d.is_dir()]:
        ensure_overview(DATA / "sites" / slug)
