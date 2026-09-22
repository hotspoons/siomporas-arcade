#!/usr/bin/env python3
"""Are the authored files still in the frame the bake now uses?

    tools/corridor/.venv/bin/python3 probes/frame-staleness.py [slug ...]

A `struct-NNNN` area is a band the seeder drew around a structure at a known along-track metre,
so it must straddle the spine there. If the frame has moved under it, the band is displaced —
measured here as the distance from the spine point at that `s` to the polygon's centroid, which
should be ~0 for a band centred on the road.

This is the check that a frame change is silent without: nothing errors, the polygons still draw,
and they sit tens of metres off the thing they were drawn around.
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent / "tools/corridor/data/sites"


def check(slug: str) -> None:
    d = ROOT / slug
    adj = d / "adjustments.json"
    if not adj.exists():
        return
    m = json.loads((d / "web/manifest.json").read_text())
    kind = (m.get("frame") or {}).get("kind", "utm")
    pts = np.array(m["spine"]["coords"])[:, :2]
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s_at = np.concatenate([[0.0], np.cumsum(seg)])
    off = []
    for a in json.loads(adj.read_text()).get("areas", []):
        if not a["id"].startswith("struct-"):
            continue
        s = float(a["id"].split("-")[1])
        c = np.array(a["polygon"]).mean(axis=0)
        p = np.array([np.interp(s, s_at, pts[:, 0]), np.interp(s, s_at, pts[:, 1])])
        off.append(float(np.linalg.norm(c - p)))
    if not off:
        return
    off = np.array(off)
    bad = (off > 10).sum()
    print(f"{slug:24s} frame={kind:4s} {len(off):3d} struct bands | centroid-to-spine: "
          f"median {np.median(off):6.1f} m  max {off.max():6.1f} m | {bad} over 10 m  "
          f"-> {'STALE' if bad else 'ok'}")


for s in sys.argv[1:] or sorted(p.name for p in ROOT.iterdir() if (p / "adjustments.json").exists()):
    check(s)
