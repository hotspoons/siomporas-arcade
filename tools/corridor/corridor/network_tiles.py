"""The tiled path for a big network (cadre §6): rasters clipped to the union corridor and cut into
1 km tiles, so an 18 km region never has to exist as one array.

    lidar/tiles/<x>_<y>.{dtm,dsm,chm,deck_z,deck_n,building_n}.tif   1 m, one per corridor tile
    lidar/{dtm,dsm,chm}.vrt                                            gdalbuildvrt over the tiles
    lidar/corridor.laz                                                 the NEAR-ROAD points only
                                                                       (within BAND_M of any chain)
    lidar/lidar.done.json                                              the point pass finished; a
                                                                       rerun reuses the two above
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

import math
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
from . import progress
from .geo import Frame
from . import rastercache

TILE_M = 1000.0
# NAIP is 0.6 m in Maryland (0.3 in some states) and the tiles were cut at 1 m, throwing away 2.8x
# the pixels the fetch had already paid for — Rich: "the satellite imagery in my home town seems
# really low res" (2026-09-26). The fetch asks for this and the tile export cuts at the source's
# own resolution, rounded to a multiple of four pixels for the KTX2 encoder.
NAIP_RES_M = 0.6
BAND_M = 15.0        # near-road points kept for the structure tests
CHM_MAX = 80.0

#: The six rasters written per 1 km tile, and the marker that says the lidar stage finished.
_TILE_KINDS = ("dtm", "dsm", "chm", "deck_z", "deck_n", "building_n")
_LIDAR_MARKER = "lidar.done.json"
_LIDAR_MARKER_VERSION = 1


def _fill_naip_blank(rgb: np.ndarray) -> float:
    """
    Replace exact-(0,0,0) no-data pixels in a (3, h, w) NAIP window with the window's own valid
    per-channel mean, and return the filled fraction.

    Every NAIP read here uses `boundless=True, fill_value=0`, which stamps zeros wherever a window
    runs past the source raster — so an edge of coverage comes out as a black slab with a dead
    straight edge. The per-tile path and the pyramid (`pyramid.fill_blank`) both fill this; the
    whole-region overview did not, and on dc-metro-take-2 that was full-height black bands of
    no-data straight across the ground the camera drives over (2026-10-07). Exact zero across all
    three channels is the fill's own signature — real NAIP essentially never is. Borrowing the
    valid mean is not a measurement, it is a plausible tone where there is none, and the eye reads
    it as more of the same ground instead of a hole.

    A window that is ENTIRELY no-data has no valid mean to borrow and is left as it is: that is
    NAIP absent for the whole view, a different failure than an edge running past coverage.
    """
    blank = (rgb == 0).all(axis=0)
    nblank = int(blank.sum())
    if not nblank or nblank >= blank.size:
        return 0.0
    for c in range(3):
        ch = rgb[c]
        ch[blank] = int(ch[~blank].mean())
    return nblank / blank.size


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


class NoLidarHere(RuntimeError):
    """
    There is no airborne lidar for this place, which is not an error about this place.

    TNM is the USGS's index and it covers the United States. Rich drew a world over Monte Bondone
    on 2026-09-27 and the bake ran the whole way through roads, OSM, GLO-30 elevation, Sentinel-2
    imagery, horizon and geology, and then died here with a bare RuntimeError and a backoff limit.
    Everything before it was already on disk and correct.

    So this is its own type: the caller catches it and carries on with elevation-derived road
    profiles, and any OTHER failure in the lidar stage still stops the bake, because that one
    really is a fault.
    """


def lidar_tiled(frame: Frame, bbox, corridor, chains: list[dict], ldir: Path, cache: Path) -> dict:
    """Points → per-tile rasters + near-road corridor.laz. Returns what the manifest records."""
    ldir.mkdir(exist_ok=True)
    tdir = ldir / "tiles"
    tdir.mkdir(exist_ok=True)
    done = _resume_lidar(frame, bbox, chains, ldir)
    if done is not None:
        return done
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
    near_parts: list[dict] = []
    counts = np.zeros(32, np.int64)
    total = 0
    demoted = 0
    meta: dict = {}
    # EPT (USGS, then NOAA) when it covers these streets, the TNM tiles otherwise — lidar.point_batches
    batches = lidar.point_batches(frame, bbox, cache, corridor, meta, lidar.dem_beside(ldir.parent))
    # a single TNM LAZ tile is 300+ MB and can take minutes, so a per-batch count alone would still
    # go quiet; the heartbeat prints "reading points, Ns in" if no batch lands within the interval
    hb = progress.Progress("lidar", None)
    while True:
        try:
            label, part = next(batches)
        except StopIteration:
            break
        except RuntimeError as exc:
            # "no lidar at all" is a fact about the place (NoLidarHere); anything else is a fault
            if total == 0 and "no lidar" in str(exc).lower():
                raise NoLidarHere(str(exc)) from exc
            raise
        if not part:
            print(f"  lidar   {label}: outside the corridor", flush=True)
            hb.tick(note=f"{label}: outside the corridor")
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
        print(f"  lidar   {label}: {len(cls):,} pts in corridor, {int(keep.sum()):,} near a road", flush=True)
        hb.tick(note=f"{label}: {total / 1e6:.0f}M pts in corridor")
        del part
    hb.close()
    # the 2 m band was only for picking the near-road points; the tiles below are the peak
    del band
    # write the tiles
    crs = frame.crs
    written = []
    pw = progress.Progress("tiles", len(acc))
    for (tx, ty), a in acc.items():
        pw.tick()
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
    pw.close()
    for kind in _TILE_KINDS:
        files = [str(tdir / f"{tx}_{ty}.{kind}.tif") for tx, ty in written]
        if files:
            subprocess.run(["gdalbuildvrt", "-q", "-overwrite", str(ldir / f"{kind}.vrt"), *files], check=True)
    # The six accumulators are 643 tile squares of six arrays on a real network and are dead once
    # the VRTs exist. Holding them through the near-road cloud below was half the peak that killed
    # bake 495 at 48 GiB (the other half was the concatenate, see the assembly). Drop them first.
    del acc
    # the near-road cloud
    #
    # Assemble ONE copy, freeing each batch as its points are copied out. `np.concatenate` built a
    # second full cloud while `near_parts` was still alive: 669 M points at 31 B each is ~21 GiB,
    # so the concat alone needed ~42 GiB with the tile accumulators still resident. Fill a
    # preallocated block instead and drop each source batch behind it, so the live set stays ~1x.
    pts = None
    if near_parts:
        keys = list(near_parts[0].keys())
        npts = sum(len(p["x"]) for p in near_parts)
        pts = {k: np.empty(npts, dtype=near_parts[0][k].dtype) for k in keys}
        off = 0
        pa = progress.Progress("assemble", len(near_parts), unit=" batches")
        for i, p in enumerate(near_parts):
            pa.tick()
            m = len(p["x"])
            if m:
                for k in keys:
                    pts[k][off:off + m] = p[k]
            off += m
            near_parts[i] = None
        pa.close()
        del near_parts
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
    zf = meta.pop("z_factor", 1.0)
    result = {**meta, "points_in_corridor": int(total), "near_road_points": int(len(pts["x"])) if pts else 0, "classes": classes, "classification": {"tiles_demoted_17_18": demoted, "class17_trusted": demoted == 0}, "z_factor": zf, "tiles": {"size_m": TILE_M, "origin": [x0, y0], "list": written}, "rasters": ["tiles/*.dtm.tif", "tiles/*.dsm.tif", "tiles/*.chm.tif", "dtm.vrt", "dsm.vrt", "chm.vrt"]}
    _mark_lidar_done(frame, bbox, chains, ldir, result, written, pts)
    return {**result, "pts": pts}


def _mark_lidar_done(frame: Frame, bbox, chains: list[dict], ldir: Path, result: dict, written: list, pts: dict | None) -> None:
    """Record that the lidar stage finished, atomically, so a later run can reuse it.

    The VRTs and the near-road cloud are the durable output but nothing said so: bake 495 wrote all
    643 tiles and their VRTs at 04:04, died on `corridor.laz`, and the rerun could not tell the
    difference between that and an empty directory, so it re-read 3.08 B cached EPT points and
    rebuilt every tile. This marker is that difference. It is written last and replaced into place
    in one step, so a run killed mid-write leaves either the old marker or none, never a half one.

    `meta` is the whole manifest record, which is what lets a reuse return exactly what the bake
    would have. It is JSON given `default=str`; a numpy scalar the source plan reports becomes a
    string on the way back, which is what `manifest.json` already stores for the same values.
    """
    if not written:
        return
    laz = ldir / "corridor.laz"
    marker = {
        "version": _LIDAR_MARKER_VERSION,
        "crs": frame.crs,
        "bbox": [float(v) for v in bbox],
        "origin": [float(v) for v in result["tiles"]["origin"]],
        "tiles": [[int(a), int(b)] for a, b in written],
        "chains": len(chains),
        "chains_sig": _chains_signature(chains),
        "near_road_points": int(result["near_road_points"]),
        "laz_bytes": int(laz.stat().st_size) if pts is not None and laz.exists() else 0,
        "meta": result,
    }
    tmp = ldir / f"{_LIDAR_MARKER}.part"
    tmp.write_text(json.dumps(marker, default=str))
    tmp.replace(ldir / _LIDAR_MARKER)


def _chains_signature(chains: list[dict]) -> str:
    """A digest of the chain geometry, so reuse is refused when the roads themselves differ.

    Positional road indices are what the near-road band assigns and what `profile_tiled` reads, so
    a chain that moved, split or was reordered makes the previous cloud the wrong shape. Count and
    total length catch most of it; the digest catches a swap or a reshape that held both. Geometry
    is rounded to 0.1 m so a re-bake of the same cached OSM does not reject itself on float noise.
    """
    import hashlib

    h = hashlib.sha1()
    for c in chains:
        line = c["line"]
        h.update(repr((len(line.coords), round(float(line.length), 1), tuple(round(float(v), 1) for v in line.bounds))).encode())
    return h.hexdigest()


def _resume_lidar(frame: Frame, bbox, chains: list[dict], ldir: Path) -> dict | None:
    """The finished lidar stage read back from disk, or None when it must be rebuilt.

    Reuse is only claimed for the SAME corridor: the marker records the frame, the snapped bbox and
    a digest of the chain geometry, and every one has to match, because a site can be re-baked with
    a wider half-width or a different primary and a tile grid from the old one is silently the
    wrong shape (the same failure `rastercache.py` documents for a stale DEM). Every recorded tile
    is also checked to still be present, so a delete or a partial volume is redone rather than
    exported as holes.
    """
    marker = ldir / _LIDAR_MARKER
    if not marker.exists():
        return None
    try:
        saved = json.loads(marker.read_text())
        if saved.get("version") != _LIDAR_MARKER_VERSION:
            return None
        if saved.get("crs") != frame.crs or int(saved.get("chains", -1)) != len(chains):
            return None
        if saved.get("chains_sig") != _chains_signature(chains):
            return None
        if [round(float(v), 2) for v in saved.get("bbox", [])] != [round(float(v), 2) for v in bbox]:
            return None
        tiles = [(int(t[0]), int(t[1])) for t in saved.get("tiles", [])]
        if not tiles:
            return None
        for tx, ty in tiles:
            for kind in _TILE_KINDS:
                f = ldir / "tiles" / f"{tx}_{ty}.{kind}.tif"
                if not f.exists() or f.stat().st_size == 0:
                    print(f"  lidar   completion marker present but {f.name} is missing; redoing the point pass", flush=True)
                    return None
        near = int(saved.get("near_road_points", 0))
        laz = ldir / "corridor.laz"
        if near and (not laz.exists() or laz.stat().st_size == 0):
            print("  lidar   completion marker present but corridor.laz is missing; redoing the point pass", flush=True)
            return None
        pts = _near_points_from_laz(bbox, chains, laz) if near else None
        if pts is not None and len(pts["x"]) != near:
            print(f"  lidar   completion marker says {near:,} near-road points but corridor.laz holds {len(pts['x']):,}; redoing the point pass", flush=True)
            return None
    except Exception as exc:
        # Any doubt at all means rebuild. Reuse that is wrong is worse than a slow bake.
        print(f"  lidar   could not reuse the finished stage ({exc}); redoing the point pass", flush=True)
        return None
    print(f"  lidar   point pass already done: reusing {near:,} near-road points over {len(tiles)} km tiles from disk", flush=True)
    return {**(saved.get("meta") or {}), "pts": pts}


def _near_points_from_laz(bbox, chains: list[dict], laz: Path) -> dict:
    """Rebuild the near-road point dict from `corridor.laz`, road index and all.

    The road index is not stored in the LAZ; it is recomputed here exactly as `lidar_tiled` made it
    for the bake and as `reprofile` makes it for a rule change — the same 2 m band, the same chain
    order, the same clipping — so `profile_tiled` sees the points it would have.
    """
    import laspy

    las = laspy.read(laz)
    pts = {
        "x": np.asarray(las.x), "y": np.asarray(las.y), "z": np.asarray(las.z),
        "cls": np.asarray(las.classification).astype(np.uint8),
        "rn": np.asarray(las.return_number).astype(np.uint8),
        "nr": np.asarray(las.number_of_returns).astype(np.uint8),
        "i": np.asarray(las.intensity).astype(np.uint16),
    }
    bw = int(np.ceil((bbox[2] - bbox[0]) / 2.0))
    bh = int(np.ceil((bbox[3] - bbox[1]) / 2.0))
    btr = from_origin(bbox[0], bbox[3], 2.0, 2.0)
    band = rasterize([(c["line"].buffer(BAND_M), i + 1) for i, c in enumerate(chains)], out_shape=(bh, bw), transform=btr, fill=0, dtype=np.int32)
    br = np.clip(((bbox[3] - pts["y"]) / 2.0).astype(np.int64), 0, bh - 1)
    bc = np.clip(((pts["x"] - bbox[0]) / 2.0).astype(np.int64), 0, bw - 1)
    pts["road"] = band[br, bc].astype(np.int16)
    return pts


def naip_tiled(frame: Frame, bbox, corridor, out: Path, cache: Path, res: float = 1.0) -> dict:
    """NAIP at `res` m over the bbox, only the service tiles that touch the corridor, written
    window by window into one JPEG-compressed GeoTIFF."""
    from io import BytesIO

    from PIL import Image

    from . import naip as naip_mod
    from .naip import TILE_PX

    if rastercache.reuse(out, frame.crs, tuple(bbox), "naip"):
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
    # The service tiles the corridor actually touches, with where each lands in the output. Build
    # the whole plan first so the downloads can run concurrently; a single GeoTIFF still has one
    # writer, so the windows are written serially afterwards — from the cache, which is instant.
    plan = []  # (r0, c0, tw, th, cache_path, params)
    for r0 in range(0, height, TILE_PX):
        for c0 in range(0, width, TILE_PX):
            tw, th = min(TILE_PX, width - c0), min(TILE_PX, height - r0)
            bx0, by1 = xmin + c0 * res, ymax - r0 * res
            if not box(bx0, by1 - th * res, bx0 + tw * res, by1).intersects(corridor):
                continue
            hit = cache / "naip" / f"{frame.epsg}_{bx0:.1f}_{by1:.1f}_{tw}x{th}_{res:g}.jpg"
            plan.append((r0, c0, tw, th, hit, {
                "bbox": f"{bx0},{by1 - th * res},{bx0 + tw * res},{by1}", "bboxSR": frame.epsg, "imageSR": frame.epsg,
                "size": f"{tw},{th}", "bandIds": "0,1,2", "format": "jpg", "pixelType": "U8", "noData": "0", "f": "image",
            }))
    naip_mod.fetch_tiles_parallel([(h, p) for _, _, _, _, h, p in plan])
    fetched = 0
    blank_tiles: list = []
    with rasterio.open(out, "w", driver="GTiff", width=width, height=height, count=3, dtype="uint8", crs=frame.crs, transform=from_origin(xmin, ymax, res, res), compress="jpeg", photometric="ycbcr", tiled=True, blockxsize=512, blockysize=512, jpeg_quality=88) as dst:
        for r0, c0, tw, th, hit, _params in plan:
            tile = np.asarray(Image.open(BytesIO(hit.read_bytes())).convert("RGB"))
            dst.write(np.moveaxis(tile, -1, 0), window=rasterio.windows.Window(c0, r0, tw, th))
            fetched += 1
            # A corridor tile that comes back all-black is a SERVICE HOLE, not "no corridor here" —
            # the plan already dropped the tiles with no corridor. The 2026-10-07 dc-metro shards
            # 1/2/7 wrote as 19 KB of pure black and nothing said so; the pyramid then painted that
            # black into the ground. Report every hole by name so a missing area is never silent.
            if (tile <= naip_mod.NAIP_BLANK_MAX).all():
                blank_tiles.append((xmin + c0 * res, ymax - r0 * res))
            print(f"  naip    tile {fetched}/{len(plan)}", flush=True)
    if blank_tiles:
        where = ", ".join(f"({x:.0f},{y:.0f})" for x, y in blank_tiles[:6])
        print(
            f"  naip    WARNING {len(blank_tiles)}/{len(plan)} planned tiles came back with NO imagery "
            f"(service gap) at {where}{' …' if len(blank_tiles) > 6 else ''}",
            flush=True,
        )
    elif not plan:
        print(f"  naip    no service tiles touch the corridor for {out.name}", flush=True)
    return {"file": out.name, "res_m": res, "size": [width, height], "tiles_fetched": fetched, "blank_tiles": len(blank_tiles)}


def _tile_grid(site_dir: Path):
    """`(x0, y0, [(tx, ty), ...])` — the 1 km UTM tile grid for a site.

    THE TILE GRID IS NOT THE LIDAR'S TO DECIDE. It was: the grid came from `manifest.lidar.tiles`,
    so a bake without a point cloud produced no tiles, and therefore no per-tile elevation, imagery
    or canopy — the whole streamed world, gone, because one optional stage was skipped. A WORLD bake
    is exactly the case that does not want a point cloud (everything lidar is for is road-local, and
    the canopy comes from the global model), so for one the grid comes from the site's own bbox,
    which is what the grid was always describing.

    ...and it is not the WORLD FLAG's to decide either. This fell back to the site's bbox only when
    the site was marked `world`, and the world editor does not mark them, so a bake with no point
    cloud — every bake outside the United States — would have produced no tiles, silently. The test
    is now simply "the lidar did not give us a grid", which is the thing that actually matters.
    """
    man = json.loads((site_dir / "manifest.json").read_text()) if (site_dir / "manifest.json").exists() else {}
    tinfo = (man.get("lidar") or {}).get("tiles") or {}
    x0, y0 = tinfo.get("origin", [None, None])
    tiles = [tuple(t) for t in tinfo.get("list", [])]
    if x0 is None or not tiles:
        site_cfg = json.loads((site_dir / "site.json").read_text()) if (site_dir / "site.json").exists() else {}
        bx = site_cfg.get("bbox_utm")
        if bx:
            x0 = math.floor(bx[0] / TILE_M) * TILE_M
            y0 = math.floor(bx[1] / TILE_M) * TILE_M
            nx = int(math.ceil((bx[2] - x0) / TILE_M))
            ny = int(math.ceil((bx[3] - y0) / TILE_M))
            tiles = [(tx, ty) for ty in range(ny) for tx in range(nx)]
            print(f"  tiles   no point cloud: {nx}x{ny} = {len(tiles)} tiles from the site's own bbox", flush=True)
    return x0, y0, tiles


#: Set in the parent before forking so every worker inherits `frame` (its pyproj Transformer cache
#: is not picklable) and the mask shapes by copy-on-write, not through a pickle per task.
_TILE_CTX: dict = {}


def _init_ctx(ctx: dict) -> None:
    """Worker initializer: timestamped stream + the tile context (a forkserver child inherits no
    module globals; see `pool.map_chunks`)."""
    from . import progress

    progress.install_timestamps()
    global _TILE_CTX
    _TILE_CTX = ctx


def _export_tiles_worker(tiles: list) -> dict:
    c = _TILE_CTX
    return _export_tiles_serial(c["site_dir"], c["web"], c["frame"], c["mask_shapes"], c["vivid"], only_tiles=tiles)


def export_tiles(site_dir: Path, web: Path, frame, mask_shapes: list, vivid) -> dict:
    """Render every 1 km tile, forked across `pool` workers (one manifest merged from the slices).

    The per-tile work is independent and writes disjoint files, so serialising it was never a
    decision — it predates the pool. `_export_tiles_serial` still owns the format; this decides how
    many slices to make, runs them, and concatenates their entries in grid order.
    """
    from . import pool

    x0, y0, tiles = _tile_grid(site_dir)
    if x0 is None or not tiles:
        return {}
    global _TILE_CTX
    _TILE_CTX = {"site_dir": site_dir, "web": web, "frame": frame, "mask_shapes": mask_shapes, "vivid": vivid}
    chunks = pool.chunk(tiles, pool.default_jobs(len(tiles)))
    parts = pool.map_chunks(_export_tiles_worker, chunks, "export", initializer=_init_ctx, initargs=(_TILE_CTX,))
    entries: list = []
    canopy = 0
    out = None
    for r in parts:
        if not r:
            continue
        out = out or r
        entries.extend(r.get("list") or [])
        canopy += int(r.get("_canopy") or 0)
    if out is None:
        return {}
    if canopy:
        print(f"  canopy  {canopy:,} tile cells outside the lidar band took the global canopy", flush=True)
    out = {k: v for k, v in out.items() if k != "_canopy"}
    out["list"] = entries
    return out


def _export_tiles_serial(site_dir: Path, web: Path, frame, mask_shapes: list, vivid, only_tiles=None) -> dict:
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

    x0, y0, tiles = _tile_grid(site_dir)
    if x0 is None or not tiles:
        return {}
    if only_tiles is not None:
        # a worker's slice; the parent resolved the grid, and every sibling resolves it identically
        tiles = [(int(x), int(y)) for x, y in only_tiles]
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
    # WHERE THE LIDAR STOPS, THE CANOPY MUST NOT READ AS ZERO. A network bake rasterises lidar
    # only in a band along the roads it draws, and chm.vrt has no nodata value, so outside the
    # band "no lidar" was written as "0 m canopy" and the tree planter grew nothing there.
    # Measured 2026-09-26 over the same 2 km of Crofton: crofton-triangle 40.7 % canopy > 3 m,
    # crofton-crownsville 10.2 %, with crownsville's DTM valid on 16 % of that ground. If the site
    # carries the global 1 m canopy (`canopy_global.tif`, from corridor.canopy / Meta-WRI), it
    # fills every cell the lidar DTM does not cover.
    dtm_p = _raster(site_dir / "lidar", "dtm")
    gchm_p = site_dir / "canopy_global.tif"
    dtm_ds = rasterio.open(dtm_p) if (dtm_p.exists() and gchm_p.exists()) else None
    gchm_ds = rasterio.open(gchm_p) if gchm_p.exists() else None
    canopy_filled = 0
    p = progress.Progress("export", len(tiles))
    for tx, ty in tiles:
        p.tick()
        bx0, by0 = x0 + tx * TILE_M, y0 + ty * TILE_M
        bx1, by1 = bx0 + TILE_M, by0 + TILE_M
        entry: dict = {"x": tx, "y": ty}
        parts: dict[str, bytes] = {}
        if dem_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=dem_ds.transform)
            z = dem_ds.read(1, window=win, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=-9999).astype(np.float32)
            # NODATA IS -9999 AND -9999 IS FINITE. A tile the DEM does not reach at all came
            # through here as a flat floor ten kilometres down, and `_fill` copies the DEM's edge
            # outward over a tile it half reaches — both from a cached DEM smaller than the site
            # (rastercache.py). The reuse check is the fix; this is the guard that keeps a hole a
            # hole rather than a cliff if it ever happens again.
            if not (np.isfinite(z) & (z > -9000)).any():
                continue
            z = _fill(z, -9999)
            rgb, zmin, scale = _encode_height(z)
            buf = io.BytesIO()
            Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True)
            parts["dem.png"] = buf.getvalue()
            entry["dem"] = {"zmin": zmin, "zscale": scale}
        # A world bake may have NO lidar canopy at all -- the point cloud is road-local now, and
        # the global model covers the whole rectangle. Where there is no lidar CHM, the global one
        # is not a fill, it IS the canopy.
        if chm_ds is None and gchm_ds is not None:
            wg = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=gchm_ds.transform)
            c = gchm_ds.read(1, window=wg, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
            c = np.clip(np.nan_to_num(c, nan=0.0), 0.0, 60.0)
            canopy_filled += int(c.size)
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
        elif chm_ds is not None:
            win = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=chm_ds.transform)
            c = chm_ds.read(1, window=win, out_shape=(n // 2, n // 2), resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
            c = np.nan_to_num(c, nan=0.0)
            if dtm_ds is not None and gchm_ds is not None:
                wl = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=dtm_ds.transform)
                zl = dtm_ds.read(1, window=wl, out_shape=c.shape, resampling=Resampling.nearest, boundless=True, fill_value=-9999).astype(np.float32)
                nolidar = ~np.isfinite(zl) | (zl <= -9998)
                if nolidar.any():
                    wg = rasterio.windows.from_bounds(bx0, by0, bx1, by1, transform=gchm_ds.transform)
                    g = gchm_ds.read(1, window=wg, out_shape=c.shape, resampling=Resampling.average, boundless=True, fill_value=0).astype(np.float32)
                    g = np.clip(np.nan_to_num(g, nan=0.0), 0.0, 60.0)
                    c[nolidar] = g[nolidar]
                    canopy_filled += int(nolidar.sum())
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
            frac = _fill_naip_blank(rgb)
            if frac:
                entry["naip_fill"] = round(frac, 3)
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
    p.close()
    naip_res_src = round(float(naip_ds.res[0]), 3) if naip_ds is not None else 1.0
    for ds in (dem_ds, chm_ds, naip_ds, dtm_ds, gchm_ds):
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
        "_canopy": canopy_filled,
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


def crossings_over(site_dir: Path) -> list[float]:
    """Along-track metres where OSM says a way crosses OVER the primary (from crossings.json).

    The overpass/gantry call in `lidar.profile` needs this to tell a real bridge deck from a sign
    gantry. `corridor plan` writes crossings.json next to the site; a bake that never planned one
    gets an empty list, which reads as "we checked and nothing crosses" — correct for a fresh
    single-image bake, and the thing that stops a motorway gantry becoming a road.
    """
    p = site_dir / "crossings.json"
    if not p.exists():
        return []
    try:
        return [float(c["s"]) for c in json.loads(p.read_text()) if c.get("relation") == "over"]
    except Exception:
        return []


def profile_tiled(line: LineString, ldir: Path, pts: dict | None, road_index: int | None = None,
                  road_index_cache: tuple | None = None, fill: bool = True,
                  crossings_over_s: list[float] | None = None) -> dict:
    """lidar.profile over the rasters with a LazyRaster, and only this road's near points.

    `road_index_cache` is `build_road_index(pts)`. Without it the road filter is `pts["road"] ==
    road_index`, which scans every one of the 669 M near-road points for EVERY chain — the
    Capital Beltway spent ~3.5 h of its bake in that scan. With it, the chain's points are a
    precomputed slice.

    `fill=False` returns the raw along-track arrays with NaN where this shard's rasters have no
    data, instead of interpolating across the gap. A shard bake wants that: it profiles the WHOLE
    primary against its OWN block's rasters, so the stations outside the block must stay NaN for
    `shards.stitch_profile` to hand them to the neighbouring shard rather than to a straight line
    drawn across them.
    """
    dtm = LazyRaster(_raster(ldir, "dtm"))
    chm = LazyRaster(_raster(ldir, "chm"))
    try:
        if pts is None:
            sub = {"x": np.zeros(0), "y": np.zeros(0), "z": np.zeros(0), "cls": np.zeros(0, np.uint8), "rn": np.zeros(0, np.uint8), "nr": np.zeros(0, np.uint8), "i": np.zeros(0, np.uint16)}
        elif road_index is not None and "road" in pts:
            span = road_index_cache[1].get(int(road_index)) if road_index_cache is not None else None
            if span is not None:
                a, b = span
                # np.sort keeps the points in their original corridor.laz order, so a profile does
                # not change just because the index exists
                sel = np.sort(road_index_cache[0][a:b])
                sub = {k: v[sel] for k, v in pts.items() if k != "road"}
            else:
                m = pts["road"] == road_index
                sub = {k: v[m] for k, v in pts.items() if k != "road"}
        else:
            sub = {k: v for k, v in pts.items() if k != "road"}
        prof = lidar.profile(line, dtm, chm, dtm.transform, sub, crossings_over_s=crossings_over_s)
        return _fill_profile(prof) if fill else prof
    finally:
        dtm.close()
        chm.close()


def build_road_index(pts: dict | None) -> tuple | None:
    """`(order, {road_id: (start, end)})` — one sort, so each chain slices its own points.

    The near-road cloud carries a `road` column naming the chain each point belongs to. Grouping it
    once turns the per-chain scan (chains x points comparisons) into chains x (their own points).
    """
    if pts is None or "road" not in pts:
        return None
    road = np.asarray(pts["road"])
    if road.shape[0] == 0:
        return None
    order = np.argsort(road)
    sr = road[order]
    change = np.flatnonzero(sr[1:] != sr[:-1]) + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [sr.shape[0]]))
    bounds = {int(sr[s]): (int(s), int(e)) for s, e in zip(starts, ends)}
    return order, bounds


def _default_jobs() -> int:
    """How many workers a profile pool may use: CORRIDOR_JOBS, else min(cpu_count, 32)."""
    import os

    env = os.environ.get("CORRIDOR_JOBS", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return max(1, min(32, os.cpu_count() or 1))


#: forked workers read the cloud from here rather than receiving tens of GB through a pickle
_PROFILE_CTX: dict = {}


def _profile_worker(task: tuple) -> dict | None:
    road_index, ident, line = task[:3]
    over_s = task[3] if len(task) > 3 else None
    ctx = _PROFILE_CTX
    try:
        return profile_tiled(line, ctx["ldir"], ctx["pts"], road_index, road_index_cache=ctx["cache"], crossings_over_s=over_s)
    except Exception as exc:  # a bad branch must not take the bake down
        print(f"  branch  {ident} profile failed: {exc}", flush=True)
        return None


def profile_many(tasks: list, ldir: Path, pts: dict | None, jobs: int | None = None) -> list:
    """Profile `(road_index, ident, line, crossings_over_s)` tasks, forked across `jobs` processes.

    The cloud is 669 M points / tens of GB; a pool that passed it through the pickle would copy it
    per task. So the pool is FORKED and the cloud is a module global: every worker inherits it
    copy-on-write, and only the (small) line is sent. Order is preserved; a failed profile returns
    None and prints, exactly as the serial loop did.

    `crossings_over_s` is the primary's OSM over-crossings (or None for a branch): see
    `crossings_over` and the overpass/gantry call in `lidar.profile`.
    """
    import multiprocessing as mp
    from concurrent.futures import ProcessPoolExecutor

    tasks = list(tasks)
    total = len(tasks)
    cache = build_road_index(pts)
    jobs = _default_jobs() if jobs is None else int(jobs)
    jobs = max(1, min(jobs, total or 1))
    # One status a minute beats an hour of silence: this is 10,137 independent profiles and the
    # fork pool used to log only "done" (Rich, 2026-10-05, watching dc-metro-take-2 sit here).
    if jobs == 1:
        p = progress.Progress("branch", total)
        out = []
        for task in tasks:
            road_index, ident, line = task[:3]
            over_s = task[3] if len(task) > 3 else None
            try:
                out.append(profile_tiled(line, ldir, pts, road_index, road_index_cache=cache, crossings_over_s=over_s))
            except Exception as exc:
                print(f"  branch  {ident} profile failed: {exc}", flush=True)
                out.append(None)
            p.tick()
        p.close()
        return out
    global _PROFILE_CTX
    _PROFILE_CTX = {"ldir": ldir, "pts": pts, "cache": cache}
    try:
        ctx = mp.get_context("fork")
    except ValueError:  # no fork (not Linux): fall back rather than pickle the cloud
        print("  branch  no fork available; profiling serially", flush=True)
        return profile_many(tasks, ldir, pts, jobs=1)
    # submit + as_completed rather than map: the same output order (each future carries its index),
    # but a result to tick on, so the pool reports "43% eta 30m" instead of going dark until the end
    from concurrent.futures import as_completed

    out: list = [None] * total
    with ProcessPoolExecutor(max_workers=jobs, mp_context=ctx) as ex:
        # Fork the workers BEFORE the heartbeat thread starts (see pool.map_chunks): a child that
        # inherits the stdout lock while the thread holds it deadlocks on its first print.
        pending = {ex.submit(_profile_worker, t): i for i, t in enumerate(tasks)}
        p = progress.Progress("branch", total)
        try:
            for fut in as_completed(pending):
                out[pending[fut]] = fut.result()
                p.tick()
        finally:
            p.close()
    return out


def profile_from_dem(line: LineString, dem_path: Path, chm_path: Path | None = None) -> dict:
    """
    The along-track profile of a road with NO POINT CLOUD: height from the elevation model.

    `lidar.profile` already takes the rasters and the points separately, so this is the same
    function with the DEM standing in for the lidar DTM and no points at all. What comes back is
    road height and the ground beside it -- but not STRUCTURES, which are read from classified
    returns (bridge decks) and cannot be inferred from a surface.

    The canopy column is ZERO here rather than the global model, because `lidar.profile` samples
    every raster through ONE transform: a 2 m canopy raster read on the DEM's 1 m lattice would be
    sampled in the wrong place, which is worse than admitting we do not have it. Nothing the
    viewer draws depends on it -- the trees come from `canopy_global.tif` through the tiles.

    Be clear about what this costs. Outside the United States the DEM is Copernicus GLO-30, a 30 m
    SURFACE model: it includes the tree canopy and the buildings, so a road under trees reads high
    and a road in a city reads like its rooftops. That is a worse road than lidar gives and a far
    better one than `profile: null`, which puts every branch at z = 0 -- sea level, with the verges
    grading down to it as walls (2026-09-26).
    """

    class _Zero:
        """`arr[rows, cols]` of zeros, without allocating a world-sized array to hold them."""

        def __init__(self, shape):
            self.shape = shape

        def __getitem__(self, idx):
            r = np.atleast_1d(np.asarray(idx[0]))
            return np.zeros(r.shape, np.float32)

    dtm = LazyRaster(dem_path)
    try:
        empty = {"x": np.zeros(0), "y": np.zeros(0), "z": np.zeros(0), "cls": np.zeros(0, np.uint8), "rn": np.zeros(0, np.uint8), "nr": np.zeros(0, np.uint8), "i": np.zeros(0, np.uint16)}
        return _fill_profile(lidar.profile(line, dtm, _Zero(dtm.shape), dtm.transform, empty))
    finally:
        dtm.close()


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
    over_s = crossings_over(site_dir)
    profiles = profile_many([(i + 1, c["id"], c["line"], over_s if c["primary"] else None) for i, c in enumerate(chains)], ldir, pts)
    if any(p is None for p in profiles):
        raise RuntimeError("reprofile: a chain failed to profile (see the log above)")
    for c, prof in zip(chains, profiles):
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


def _read_strips(path: Path, bbox, res: float, count: int = 1, strips: int | None = None):
    """Read a whole UTM bbox at `res`, one horizontal strip per THREAD, each its own GDAL handle.

    `overview()` read each 1 m source in a single `rasterio.read` over the whole site, and for a
    world those sources are VRTs of hundreds of 1 km tiles with no overviews — so GDAL decodes every
    source pixel at full resolution to average it down. On the Capital Beltway's `naip_1m.tif` that
    was hours in one call, with no log line between start and finish (corridor-bake-495, 2026-10-04,
    silent for 3.4 h at "overview dem …"). The output rows are independent, so the read is split into
    strips and run concurrently.

    THREADS, NOT FORK. Each thread opens the dataset itself (a GDAL handle is not safe to read from
    two threads, and a forked child would share the parent's file offset), and the decode/reproject
    is in GDAL C, which releases the GIL. No process pool, so no pickling and no fork-of-threads.
    """
    import os

    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    with rasterio.open(path) as src:
        w = int(round((bbox[2] - bbox[0]) / res))
        h = int(round((bbox[3] - bbox[1]) / res))
    if w <= 0 or h <= 0:
        return None, (w, h)
    n = strips or min(8, os.cpu_count() or 1)
    n = max(1, min(n, h))
    rows = [((i * h) // n, ((i + 1) * h) // n) for i in range(n)]
    rows = [(r0, r1) for r0, r1 in rows if r1 > r0]

    def one(r0: int, r1: int):
        # output row r spans UTM y from bbox[3]-r*res (north) down; row 0 is the north edge
        y_north, y_south = bbox[3] - r0 * res, bbox[3] - r1 * res
        with rasterio.open(path) as s:
            win = from_bounds(bbox[0], y_south, bbox[2], y_north, transform=s.transform)
            fill = s.nodata if (s.nodata is not None and count == 1) else 0
            return s.read(out_shape=(count, r1 - r0, w), window=win, resampling=Resampling.average, boundless=True, fill_value=fill)

    if len(rows) <= 1:
        a = one(*rows[0]) if rows else None
    else:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=len(rows)) as ex:
            parts = list(ex.map(lambda r: one(*r), rows))
        a = np.concatenate(parts, axis=1)  # axis 1 is the row axis for both (1,h,w) and (3,h,w)
    return (a[0] if (a is not None and count == 1) else a), (w, h)


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
        return _read_strips(path, bbox, res, count)

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
        # This is ONE mosaic of the whole site, so a gap in NAIP coverage is a black band right
        # across the ground rather than a single tile's edge — it must be filled the same way the
        # per-tile and pyramid paths fill theirs (`_fill_naip_blank`).
        frac = _fill_naip_blank(rgb)
        if frac:
            print(f"  naip_overview filled {frac:.1%} no-data")
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
    # `overview` wants the frame itself (`frame.control_lattice`, `_enu_bbox(frame, b)`), not the
    # raw origin it happens to carry — passing `ox, oy` was a leftover from before the ENU/geodetic
    # rework and made this repair script raise TypeError instead of repairing anything.
    frame = Frame(site["frame"]["epsg"], (ox, oy))
    ov = overview(site_dir, web, frame, mask_shapes(site_dir, derived), vivid)
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
