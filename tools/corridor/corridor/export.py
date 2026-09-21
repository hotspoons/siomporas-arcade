"""Web export: the site, in the shapes a browser can decode without a GIS stack.

GeoTIFFs are the archive. A viewer (apps/corridor) and eventually the game want small, decodable
layers, all on the same lattice, with a manifest that says where each one sits in the site frame:

    web/dem_2m.png       height, RGB-encoded uint16 (R = high byte, G = low byte) in centimetres
                         above `zmin`. Why RGB and not a 16-bit PNG: browsers decode 16-bit PNGs to
                         8 bits per channel on the canvas, silently. Two 8-bit channels survive.
    web/chm_2m.png       canopy height, 8-bit, 0.25 m per step (0-63 m), on the DEM lattice
    web/naip_1m.jpg      imagery, 1 m/px (6600×1300 for a corridor; one texture)
    web/horizon_60m.png  the far terrain, same encoding as the DEM, 1000² over 60 km
    web/manifest.json    frame, per-layer georeferencing, the spine with z, structures, crossings,
                         profile every 10 m, geology, photos. Coordinates are METRES RELATIVE TO
                         THE SITE ORIGIN so the viewer never sees a six-digit easting.

`sites/index.json` lists every exported site. Both are what `publish` puts in the bucket and what
the Worker will hand the browser, so the viewer is already reading the production shape.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from shapely.geometry import LineString

Z_SCALE = 0.01  # metres per count; 655 m of range in a uint16


def _fill(a: np.ndarray, nodata: float) -> np.ndarray:
    from scipy import ndimage

    bad = ~np.isfinite(a) | (a <= nodata + 1)
    if bad.any() and not bad.all():
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        a = a[tuple(idx)]
    return a


def _encode_height(z: np.ndarray) -> tuple[np.ndarray, float, float]:
    zmin = float(np.floor(np.nanmin(z)))
    scale = Z_SCALE
    while (np.nanmax(z) - zmin) / scale > 65000:
        scale *= 2
    q = np.clip(np.round((z - zmin) / scale), 0, 65535).astype(np.uint16)
    rgb = np.zeros((*q.shape, 3), np.uint8)
    rgb[..., 0] = q >> 8
    rgb[..., 1] = q & 0xFF
    return rgb, zmin, scale


def _read_at(path: Path, res: float, bbox=None) -> tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        b = src.bounds
        if bbox is None:
            bbox = (b.left, b.bottom, b.right, b.top)
        w = int(round((bbox[2] - bbox[0]) / res))
        h = int(round((bbox[3] - bbox[1]) / res))
        from rasterio.windows import from_bounds

        win = from_bounds(*bbox, transform=src.transform)
        a = src.read(1, window=win, out_shape=(h, w), resampling=Resampling.average, boundless=True, fill_value=src.nodata if src.nodata is not None else 0)
        nodata = src.nodata
    return a.astype(np.float32), {"bbox": [float(v) for v in bbox], "res": res, "size": [w, h], "nodata": nodata}



def _smooth_on_line(raw, sigma: float = 15.0, max_dev: float = 1.5):
    """Smooth the digitising jitter out of a centreline WITHOUT leaving the road.

    A plain gaussian over the vertices cuts corners: at sigma 15 samples (30 m) the spine left the
    real centreline by up to 10.6 m on a bend, which is the road sitting visibly beside its own
    trace in the air photo (Rich, 2026-09-21). Angular paint and a snapping camera were why the
    smoothing went in, and those come from vertex-to-vertex direction changes, not from position —
    so smooth, then pull every point back to within `max_dev` of the raw polyline. Jitter of a
    metre disappears; a real curve is kept.
    """
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    from shapely.geometry import LineString, Point

    if len(raw) < 4:
        return raw
    sm = np.column_stack([gaussian_filter1d(raw[:, 0], sigma, mode="nearest"), gaussian_filter1d(raw[:, 1], sigma, mode="nearest")])
    sm[0], sm[-1] = raw[0], raw[-1]
    line = LineString(raw)
    for i in range(1, len(sm) - 1):
        p = Point(sm[i])
        d = p.distance(line)
        if d > max_dev:
            q = line.interpolate(line.project(p))
            f = (d - max_dev) / d
            sm[i] = (sm[i][0] + (q.x - sm[i][0]) * f, sm[i][1] + (q.y - sm[i][1]) * f)
    return sm

def export_site(site_dir: Path) -> dict:
    site = json.loads((site_dir / "site.json").read_text())
    manifest = json.loads((site_dir / "manifest.json").read_text()) if (site_dir / "manifest.json").exists() else {}
    ox, oy = site["frame"]["origin"]
    bbox = tuple(site["bbox_utm"])
    web = site_dir / "web"
    web.mkdir(exist_ok=True)
    layers: dict = {}

    def rel_bbox(b):
        return [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]

    # network sites over 6 km go out as 1 km tiles (network_tiles.export_tiles, below); the
    # single-image dem/chm/naip blocks are skipped for them — an 18 km DEM PNG is 85 M pixels
    tiled = bool(manifest.get("tiled"))

    # --- near terrain --------------------------------------------------------------------------
    if (site_dir / "dem_1m.tif").exists() and not tiled:
        z, g = _read_at(site_dir / "dem_1m.tif", 2.0, bbox)
        z = _fill(z, -9999)
        rgb, zmin, scale = _encode_height(z)
        Image.fromarray(rgb, "RGB").save(web / "dem_2m.png", optimize=True)
        layers["dem"] = {"file": "dem_2m.png", "res": 2.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "zmin": zmin, "zscale": scale}

    # buildings / landuse / POIs in corridor coordinates (AUTOGEN.md §10) — derived here, before the
    # canopy layer, because the canopy mask below needs the footprints. (The first version read them
    # from web/buildings.json, a file nothing ever wrote: the mask was a silent no-op on all nine
    # sites — found by the editor agent with probes/chm-buildings-check.py, 2026-09-21.)
    try:
        from . import buildings as bld
        derived = bld.derive(site_dir)
    except Exception as exc:
        print(f"  buildings failed: {exc}")
        derived = {"buildings": [], "landuse": [], "pois": [], "summary": {}}

    # --- canopy on the same lattice ------------------------------------------------------------
    chm_path = site_dir / "lidar" / "chm.tif"
    if chm_path.exists() and "dem" in layers and not tiled:
        c, g = _read_at(chm_path, 2.0, bbox)  # boundless: 0 outside the lidar corridor
        c = np.nan_to_num(c, nan=0.0)
        # The canopy model is "unclassified points above ground", and on a working interstate that
        # includes every truck the flight caught: a tractor-trailer is a 4 m "tree" on the pavement.
        # Zero the canopy over both carriageways (paved width + 2 m) so nothing grows on the road.
        from rasterio.features import rasterize
        from rasterio.transform import from_origin

        sp0 = json.loads((site_dir / "spine_utm.json").read_text())
        lanes_max = 2
        for seg in sp0.get("segments", []):
            try:
                lanes_max = max(lanes_max, int(seg["tags"].get("lanes", 2)))
            except ValueError:
                pass
        half = (lanes_max * 3.66 + 4.2) / 2 + 2.0
        shapes = [(LineString(sp0["coords"]).buffer(half, cap_style="flat"), 1)]
        for sib in sp0.get("siblings", []):
            gg = sib["geometry"]
            parts = [gg["coordinates"]] if gg["type"] == "LineString" else gg["coordinates"]
            for part in parts:
                if len(part) > 1:
                    shapes.append((LineString(part).buffer(half, cap_style="flat"), 1))
        tr2 = from_origin(g["bbox"][0], g["bbox"][3], 2.0, 2.0)
        # A roof is the same problem as a truck: this lidar has no vegetation classes, canopy is
        # "unassigned above ground", so every building footprint is also a 6 m tree — and autogen
        # now stands a model on each one (editor agent, 2026-09-21). Zero the canopy under every
        # OSM footprint (+1 m), in the bake, so viewer, editor and preview all get it.
        from shapely.geometry import Polygon
        ox, oy = site["frame"]["origin"]
        for b in derived.get("buildings", []):
            ring = b.get("ring") or []
            if len(ring) >= 3:
                shapes.append((Polygon([(x + ox, y + oy) for x, y in ring]).buffer(1.0), 1))
        road_mask = rasterize(shapes, out_shape=c.shape, transform=tr2, fill=0, dtype=np.uint8).astype(bool)
        c[road_mask] = 0.0
        Image.fromarray(np.clip(np.round(c * 4), 0, 255).astype(np.uint8), "L").save(web / "chm_2m.png", optimize=True)
        layers["chm"] = {"file": "chm_2m.png", "res": 2.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "scale": 0.25}

    # --- imagery -------------------------------------------------------------------------------
    # NAIP is flown for measurement, not for looks: leaf-on, high sun, and the service's overview
    # mosaic at 60 m is a desaturated grey-green (35% grey on average). Under fog and a hemisphere
    # light it reads as beige. Push saturation and contrast at export so the drape carries the
    # colour the eye expects from a Maryland ridge; the GeoTIFF stays untouched for measurement.
    from PIL import ImageEnhance

    def vivid(img: Image.Image, sat: float, con: float, green: float = 1.0) -> Image.Image:
        img = ImageEnhance.Color(img).enhance(sat)
        img = ImageEnhance.Contrast(img).enhance(con)
        if green != 1.0:
            r, g, b = img.split()
            g = g.point(lambda v: min(255, int(v * green)))
            img = Image.merge("RGB", (r, g, b))
        return img

    if tiled:
        try:
            from . import network_tiles

            tl = network_tiles.export_tiles(site_dir, web, ox, oy, network_tiles.mask_shapes(site_dir, derived), vivid)
            if tl:
                layers["tiles"] = tl
                print(f"  tiles   {len(tl['list'])} km tiles -> web/tiles/0", flush=True)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            print(f"  tiles failed: {exc}")
    if (site_dir / "naip.tif").exists() and not tiled:
        with rasterio.open(site_dir / "naip.tif") as src:
            w = int(round((bbox[2] - bbox[0]) / 1.0))
            h = int(round((bbox[3] - bbox[1]) / 1.0))
            rgb = src.read(out_shape=(3, h, w), resampling=Resampling.average)
        # warm it a touch as well: NAIP's blue channel runs high and the drape read as teal
        img = vivid(Image.fromarray(np.moveaxis(rgb, 0, -1), "RGB"), 1.3, 1.1)
        r_, g_, b_ = img.split()
        img = Image.merge("RGB", (r_.point(lambda v: min(255, int(v * 1.06))), g_, b_.point(lambda v: int(v * 0.9))))
        img.save(web / "naip_1m.jpg", quality=85, optimize=True)
        layers["naip"] = {"file": "naip_1m.jpg", "res": 1.0, "size": [w, h], "bbox": rel_bbox(bbox)}

    # --- far terrain ---------------------------------------------------------------------------
    if (site_dir / "horizon_30m.tif").exists():
        z, g = _read_at(site_dir / "horizon_30m.tif", 60.0)
        z = _fill(z, -9999)
        rgb, zmin, scale = _encode_height(z)
        Image.fromarray(rgb, "RGB").save(web / "horizon_60m.png", optimize=True)
        layers["horizon"] = {"file": "horizon_60m.png", "res": 60.0, "size": g["size"], "bbox": rel_bbox(g["bbox"]), "zmin": zmin, "zscale": scale}
        if (site_dir / "horizon_naip_60m.jpg").exists():
            vivid(Image.open(site_dir / "horizon_naip_60m.jpg").convert("RGB"), 1.9, 1.25, 1.06).save(web / "horizon_naip_60m.jpg", quality=88)
            layers["horizon_naip"] = {"file": "horizon_naip_60m.jpg", "res": 60.0, "size": g["size"], "bbox": rel_bbox(g["bbox"])}

    # --- vectors, relative to the origin -------------------------------------------------------
    spine = json.loads((site_dir / "spine_utm.json").read_text())
    coords = np.array(spine["coords"])
    line = LineString(coords)
    prof = json.loads((site_dir / "profile.json").read_text()) if (site_dir / "profile.json").exists() else None
    # Densify to 10 m so a spline through the points is smooth in plan AND in grade: OSM nodes are
    # hundreds of metres apart on a straight, and z comes from the lidar profile every 2 m, which a
    # node-only line would throw away.
    # OSM draws a highway curve as chords between nodes 20-100 m apart. Densifying the chords and
    # fitting a spline through the dense points reproduces the chords, kinks included. So the
    # line is smoothed FIRST, along-track, with a Gaussian of sigma 30 m — a real interstate curve
    # has a radius of 300 m or more, so nothing real is lost and the chord corners are gone. The
    # smoothed line drifts from OSM's centreline by under a metre on tight ramps; a highway lane
    # is 3.66 m wide.
    from scipy.ndimage import gaussian_filter1d

    step = 10.0
    fine = np.arange(0.0, line.length, 2.0).tolist() + [line.length]
    raw = np.array([line.interpolate(v).coords[0] for v in fine])
    sm = _smooth_on_line(raw)
    smooth_line = LineString(sm)
    s_dense = np.arange(0.0, smooth_line.length, step).tolist() + [smooth_line.length]
    pts = np.array([smooth_line.interpolate(v).coords[0] for v in s_dense])
    if prof:
        zs = np.interp(np.array(s_dense), np.array(prof["s"]), np.array(prof["road_z"]))
    else:
        # No lidar here (the 2008 Oregon delivery has no CRS, the California coast has no EPT):
        # the road's grade is then the bare-earth DEM under the centreline, lightly smoothed. Zero
        # buried Ragged Point's road 33 m under its own terrain — "only terrain, no roads"
        # (Rich, 2026-09-21).
        dem_p = site_dir / "dem_1m.tif"
        if dem_p.exists():
            import rasterio as _rio
            with _rio.open(dem_p) as _src:
                zs = np.array([v[0] for v in _src.sample([(float(x), float(y)) for x, y in pts])], dtype=float)
            zs[zs < -9000] = np.nan
            if np.isnan(zs).any() and np.isfinite(zs).any():
                ok = np.isfinite(zs)
                zs[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), zs[ok])
            zs = np.nan_to_num(zs, nan=0.0)
            if len(zs) > 9:  # a car follows the road, not the 1 m noise of a bare-earth raster
                k = np.ones(9) / 9
                zs = np.convolve(np.pad(zs, 4, mode="edge"), k, mode="valid")
            print(f"  export  no lidar profile; spine grade from the DEM ({zs.min():.1f}–{zs.max():.1f} m)", flush=True)
        else:
            zs = np.zeros(len(s_dense))
    spine_rel = np.column_stack([pts[:, 0] - ox, pts[:, 1] - oy, zs]).round(2).tolist()

    siblings = []
    for sib in spine.get("siblings", []):
        g = sib["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for part in parts:
            if len(part) < 2:
                continue
            ln = LineString(part)
            if ln.length < 40:
                continue
            fine2 = np.arange(0.0, ln.length, 2.0).tolist() + [ln.length]
            raw2 = np.array([ln.interpolate(v).coords[0] for v in fine2])
            sm2 = _smooth_on_line(raw2)
            sm2[0], sm2[-1] = raw2[0], raw2[-1]
            ln2 = LineString(sm2)
            dense2 = np.array([ln2.interpolate(v).coords[0] for v in np.arange(0.0, ln2.length, step).tolist() + [ln2.length]])
            siblings.append(np.column_stack([dense2[:, 0] - ox, dense2[:, 1] - oy]).round(2).tolist())

    profile_10 = None
    if prof:
        step = max(1, int(round(10.0 / prof["step_m"])))
        keys = ["left_8", "right_8", "left_15", "right_15", "left_40", "right_40"]
        profile_10 = {
            "s": prof["s"][::step],
            "road_z": prof["road_z"][::step],
            "ground_rel": {k: prof["ground_rel"][k][::step] for k in keys if k in prof["ground_rel"]},
            "canopy": {k: prof["canopy"][k][::step] for k in ("left_15", "right_15", "left_40", "right_40") if k in prof["canopy"]},
        }

    surface = json.loads((site_dir / "surface.json").read_text()) if (site_dir / "surface.json").exists() else None
    crossings = json.loads((site_dir / "crossings.json").read_text()) if (site_dir / "crossings.json").exists() else []
    geology = json.loads((site_dir / "geology.json").read_text()) if (site_dir / "geology.json").exists() else {}

    # buildings/landuse/POIs: `derived`, computed above the canopy layer

    # terrain features (terrain-and-data agent, 2026-09-21): cut faces, exposed rock, water. Each
    # module measures from the rasters + OSM and writes its own <site>/{cuts,rock,water}.json;
    # the manifest carries the dict. cuts before rock (rock reads cuts.json). No lidar → null.
    import importlib

    features: dict = {}
    for name in ("cuts", "rock", "water"):
        mod = importlib.import_module(f".{name}", __package__)
        # a network samples per road / per raster tile through a windowed reader; a corridor reads
        # its one DTM into an array. Same rules either way — see water._Heights for why.
        fn = getattr(mod, "measure_network", None) if tiled else None
        try:
            features[name] = (fn or mod.measure)(site_dir)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            print(f"  {name} failed: {exc}")
            features[name] = None
        if features[name] and features[name].get("summary"):
            print(f"  {name:7s} {features[name]['summary']}", flush=True)

    out = {
        "slug": site["slug"],
        "ident": site.get("ident"),
        "frame": site["frame"],
        "bbox": rel_bbox(bbox),
        "layers": layers,
        "spine": {"coords": spine_rel, "photo_s": spine["photo_s"], "length_m": round(float(line.length), 1), "segments": spine.get("segments", [])},
        "siblings": siblings,
        "structures": prof["structures"] if prof else [],
        "crossings": [{k: c.get(k) for k in ("s", "kind", "relation", "name", "inferred")} for c in crossings],
        "surface": {"step_m": surface["step_m"], "s": surface["stations"]["s"], "class": surface["stations"]["class"], "lidar_ratio": surface["stations"]["lidar_ratio"], "naip_brightness": surface["stations"]["naip_brightness"], "segments": surface["segments"], "summary": surface["summary"]} if surface else None,
        "profile": profile_10,
        "geology": {"named_formations": geology.get("named_formations", []), "units": [{k: u.get(k) for k in ("name", "strat_name", "lith", "descrip", "b_age", "t_age")} for u in geology.get("units", []) if u.get("strat_name")]},
        "photos": [{"file": p["file"], "heading_deg": p.get("heading_deg"), "taken": p.get("taken")} for p in site.get("photos", [])],
        "lidar": {k: manifest.get("lidar", {}).get(k) for k in ("dataset", "points_in_corridor", "classes")},
        "buildings": derived["buildings"],
        "landuse": derived["landuse"],
        "pois": derived["pois"],
        "cuts": features.get("cuts"),
        "rock": features.get("rock"),
        "water": features.get("water"),
    }
    # network sites (cadre §6): every other road as a first-class branch — coords with lidar grade,
    # junctions, profile, structures. `siblings` above stays as it was for the old viewer path.
    try:
        from . import network

        br = network.export_branches(site_dir, ox, oy)
        if br is not None:
            out["network"] = True
            out["roads"] = spine.get("roads", [])
            out["junctions"] = (spine.get("primary") or {}).get("junctions", [])
            out["branches"] = br
    except Exception as exc:
        print(f"  branches failed: {exc}")
    (web / "manifest.json").write_text(json.dumps(out))
    return {"layers": list(layers), "bytes": sum(f.stat().st_size for f in web.iterdir()), "buildings": derived["summary"]}


def write_index(sites_dir: Path) -> Path:
    entries = []
    for d in sorted(sites_dir.glob("*")):
        m = d / "web" / "manifest.json"
        if not m.exists():
            continue
        j = json.loads(m.read_text())
        entries.append({"slug": j["slug"], "ident": j.get("ident"), "length_m": j["spine"]["length_m"], "structures": len(j["structures"]), "formations": j["geology"]["named_formations"][:4], "layers": list(j["layers"]), "photos": [p["file"] for p in j["photos"]]})
    out = sites_dir / "index.json"
    out.write_text(json.dumps({"sites": entries}, indent=1))
    return out
