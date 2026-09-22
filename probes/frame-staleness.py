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
    # Distance from the band's centroid to the NEAREST point on the spine, not to the spine at the
    # `s` in its id. A band runs s_start-pad .. s_end+pad, so on a curve or over a long structure
    # its centroid is tens of metres along from s_start — which the first version of this read as
    # staleness and reported on correctly-reseeded files. The question is "is this band still on
    # the road", and that is a distance to the line, not to a station.
    off = []
    for a in json.loads(adj.read_text()).get("areas", []):
        if not a["id"].startswith("struct-"):
            continue
        c = np.array(a["polygon"]).mean(axis=0)
        d = np.linalg.norm(pts - c, axis=1)
        j = int(d.argmin())
        lo, hi = max(0, j - 2), min(len(pts), j + 3)
        seg_d = []
        for k in range(lo, hi - 1):
            u = pts[k + 1] - pts[k]
            t = np.clip(np.dot(c - pts[k], u) / max(1e-9, np.dot(u, u)), 0.0, 1.0)
            seg_d.append(np.linalg.norm(pts[k] + t * u - c))
        off.append(float(min(seg_d) if seg_d else d[j]))
    if not off:
        return
    off = np.array(off)
    bad = (off > 10).sum()
    print(f"{slug:24s} frame={kind:4s} {len(off):3d} struct bands | centroid-to-spine: "
          f"median {np.median(off):6.1f} m  max {off.max():6.1f} m | {bad} over 10 m  "
          f"-> {'STALE' if bad else 'ok'}")


for s in sys.argv[1:] or sorted(p.name for p in ROOT.iterdir() if (p / "adjustments.json").exists()):
    check(s)
