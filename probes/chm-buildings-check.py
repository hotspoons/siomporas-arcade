#!/usr/bin/env python3
"""Is the canopy actually zeroed under building footprints?

    tools/corridor/.venv/bin/python3 probes/chm-buildings-check.py [slug ...]

This lidar has no vegetation classes — canopy is "unassigned above ground" — so every roof is
also a tree. `export.py` masks the road out of the CHM for the same reason (a truck is a 4 m
tree on the pavement) and should mask buildings too, now that autogen stands a model on each one.

The test does not trust a screenshot: it rasterizes each footprint, takes the mean canopy INSIDE
it, and compares that against an ANNULUS 12-30 m outside it (with every other footprint removed
from the annulus, so a dense street does not contaminate its own control).

    masked correctly -> inside ≈ 0, and far below the annulus
    not masked       -> inside ABOVE the annulus, because a roof reads taller than a lawn
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import Polygon

ROOT = Path(__file__).resolve().parent.parent / "tools/corridor/data/sites"


def check(slug: str) -> None:
    web = ROOT / slug / "web"
    m = json.loads((web / "manifest.json").read_text())
    blds = m.get("buildings") or []
    if not blds:
        print(f"{slug:22s} no buildings in the manifest")
        return
    L = m["layers"]["chm"]
    chm = np.asarray(Image.open(web / L["file"])).astype(np.float32) * L.get("scale", 0.25)
    x0, _, _, y1 = L["bbox"]
    tr = from_origin(x0, y1, L["res"], L["res"])
    polys = [Polygon(b["ring"]) for b in blds if len(b["ring"]) >= 3]
    polys = [p for p in polys if p.is_valid and p.area > 1]
    inner = rasterize([(p, 1) for p in polys], out_shape=chm.shape, transform=tr, fill=0, dtype=np.uint8).astype(bool)
    # the annulus, minus every footprint, so the control is genuinely off-building
    grown = rasterize([(p.buffer(30), 1) for p in polys], out_shape=chm.shape, transform=tr, fill=0, dtype=np.uint8).astype(bool)
    near = rasterize([(p.buffer(12), 1) for p in polys], out_shape=chm.shape, transform=tr, fill=0, dtype=np.uint8).astype(bool)
    ring = grown & ~near
    i, r = chm[inner], chm[ring]
    verdict = "MASKED" if i.mean() < 0.2 else "NOT MASKED"
    print(f"{slug:22s} {len(polys):4d} footprints | inside: mean {i.mean():5.2f} m, {100 * (i > 0.3).mean():5.1f}% treed"
          f" | annulus: mean {r.mean():5.2f} m, {100 * (r > 0.3).mean():5.1f}% treed  -> {verdict}")


for s in sys.argv[1:] or sorted(d.name for d in ROOT.iterdir() if (d / "web/manifest.json").exists()):
    check(s)
