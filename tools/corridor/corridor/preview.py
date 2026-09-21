"""One picture per site: imagery, the spine, canopy, crossings and measured structures.

Not a deliverable — a check. Every number in profile.json should be visible here as a shape in
the right place before anyone builds a road on it.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from rasterio.enums import Resampling

SCALE = 2.0  # metres per preview pixel


def render(site_dir: Path) -> Path | None:
    site = json.loads((site_dir / "site.json").read_text())
    xmin, ymin, xmax, ymax = site["bbox_utm"]
    w, h = int((xmax - xmin) / SCALE), int((ymax - ymin) / SCALE)

    def px(x, y):
        return ((np.asarray(x) - xmin) / SCALE, (ymax - np.asarray(y)) / SCALE)

    if (site_dir / "naip.tif").exists():
        with rasterio.open(site_dir / "naip.tif") as src:
            rgb = src.read(out_shape=(3, h, w), resampling=Resampling.average)
        img = Image.fromarray(np.moveaxis(rgb, 0, -1)).convert("RGBA")
    else:
        img = Image.new("RGBA", (w, h), (40, 40, 40, 255))

    chm_path = site_dir / "lidar" / "chm.tif"
    if chm_path.exists():
        with rasterio.open(chm_path) as src:
            chm = src.read(1, out_shape=(h, w), resampling=Resampling.average)
            b = src.bounds
        alpha = np.clip(chm / 25.0, 0, 1) * 160
        layer = np.zeros((h, w, 4), np.uint8)
        layer[..., 1] = 255
        layer[..., 3] = alpha.astype(np.uint8)
        ov = Image.fromarray(layer)
        # chm raster covers the lidar bbox, which sits inside the site bbox
        ox, oy = px(b.left, b.top)
        img.alpha_composite(ov.resize((int((b.right - b.left) / SCALE), int((b.top - b.bottom) / SCALE))), (int(ox), int(oy)))

    d = ImageDraw.Draw(img)
    spine = json.loads((site_dir / "spine_utm.json").read_text())
    coords = np.array(spine["coords"])
    xs, ys = px(coords[:, 0], coords[:, 1])
    d.line(list(zip(xs.tolist(), ys.tolist())), fill=(255, 220, 0, 255), width=3)
    for sib in spine.get("siblings", []):
        g = sib["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for ln in lines:
            c = np.array(ln)
            sx, sy = px(c[:, 0], c[:, 1])
            d.line(list(zip(sx.tolist(), sy.tolist())), fill=(255, 140, 0, 200), width=2)

    from shapely.geometry import LineString

    line = LineString(coords)
    cross_path = site_dir / "crossings.json"
    if cross_path.exists():
        for c in json.loads(cross_path.read_text()):
            x, y = line.interpolate(c["s"]).coords[0]
            cx, cy = px(x, y)
            col = {"over": (255, 40, 40, 255), "under": (40, 120, 255, 255)}.get(c["relation"], (255, 255, 255, 255))
            d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], outline=col, width=3)
    prof_path = site_dir / "profile.json"
    if prof_path.exists():
        for st in json.loads(prof_path.read_text())["structures"]:
            a = line.interpolate(st["s_start"]).coords[0]
            b = line.interpolate(st["s_end"]).coords[0]
            ax, ay = px(*a)
            bx, by = px(*b)
            col = (0, 255, 255, 255) if st["kind"] == "overpass" else (255, 0, 255, 255)
            d.line([(ax, ay), (bx, by)], fill=col, width=9)
    x, y = line.interpolate(spine["photo_s"]).coords[0]
    cx, cy = px(x, y)
    d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=(255, 255, 255, 255), width=4)
    out = site_dir / "preview.png"
    img.convert("RGB").save(out)
    return out
