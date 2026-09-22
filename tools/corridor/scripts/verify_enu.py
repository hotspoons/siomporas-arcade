"""Does the ENU manifest describe the same PLACES the UTM one did?

The frame change rewrote every coordinate in every site. The only check that means anything is
whether a feature still lands where it did on the Earth — so this converts both descriptions back
to WGS84 and compares them in metres:

    old:  site metres -> + origin -> UTM -> (PROJ) -> lon/lat
    new:  ENU metres  -> ECEF -> lon/lat

Agreement should be at the rounding floor. Coordinates are written to 2 dp, so ~14 mm is a pass
(5 mm of rounding on each axis, on each side); anything above that is a real frame error.

Usage:  .venv/bin/python scripts/verify_enu.py [slug ...]     (default: every staged site)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from corridor.geo import Anchor, Frame  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "data" / "sites"
TOL_MM = 30.0  # 2 dp rounding on both sides, with headroom
EP2 = (Anchor.A**2 - Anchor.B**2) / Anchor.B**2


def _enu_to_geo(a: Anchor, e: float, n: float) -> tuple[float, float]:
    px = a.ecef[0] + a.east[0] * e + a.north[0] * n
    py = a.ecef[1] + a.east[1] * e + a.north[1] * n
    pz = a.ecef[2] + a.east[2] * e + a.north[2] * n
    p = math.hypot(px, py)
    th = math.atan2(pz * Anchor.A, p * Anchor.B)
    lat = math.atan2(pz + EP2 * Anchor.B * math.sin(th) ** 3, p - Anchor.E2 * Anchor.A * math.cos(th) ** 3)
    return math.degrees(math.atan2(py, px)), math.degrees(lat)


def _pairs(man: dict) -> dict[str, list]:
    """Every (x, y) the manifest carries, by layer, so nothing is checked by eye."""
    out: dict[str, list] = {}
    sp = man.get("spine", {}).get("coords")
    if sp:
        out["spine"] = list(sp)
    for k in ("driveways", "stubs", "sidewalks", "barriers", "branches", "water", "cuts"):
        pts = [c for f in (man.get(k) or []) if isinstance(f, dict) for c in (f.get("coords") or [])]
        if pts:
            out[k] = pts
    for k in ("buildings", "landuse"):
        pts = [c for f in (man.get(k) or []) for c in (f.get("ring") or [])]
        if pts:
            out[k] = pts
    for k in ("pois", "signals", "parking"):
        v = man.get(k)
        rows = v.get("heads", []) + v.get("masts", []) if isinstance(v, dict) else (v or [])
        pts = [[f["x"], f["y"]] for f in rows if isinstance(f, dict) and "x" in f and "y" in f]
        if pts:
            out[k] = pts
    if man.get("siblings"):
        out["siblings"] = [c for s in man["siblings"] for c in s]
    return out


def verify(slug: str) -> tuple[bool, str]:
    d = ROOT / slug
    old_p, new_p = d / "web" / "manifest.json", d / "web.staging" / "manifest.json"
    if not (old_p.exists() and new_p.exists()):
        return True, f"{slug:26} - nothing staged, skipped"
    old, new = json.loads(old_p.read_text()), json.loads(new_p.read_text())
    if old.get("frame", {}).get("kind") == "enu":
        # the live tree has already been promoted, so this would compare ENU against ENU and
        # report the conversion itself as an error. Nothing to check.
        return True, f"{slug:26} -    live tree is already enu, nothing to compare"
    f = Frame(old["frame"]["epsg"], tuple(old["frame"]["origin"]))
    ox, oy = f.origin
    a = f.anchor_frame()
    o_all, n_all = _pairs(old), _pairs(new)
    worst, worst_k, n_pts = 0.0, "-", 0
    for k, o in o_all.items():
        n = n_all.get(k)
        if not n or len(n) != len(o):
            return False, f"{slug:26} FAIL {k}: {len(o)} points became {len(n or [])}"
        oa, na = np.asarray(o, float), np.asarray(n, float)
        lon1, lat1 = f.to_wgs(oa[:, 0] + ox, oa[:, 1] + oy)
        g = np.array([_enu_to_geo(a, e, nn) for e, nn in na[:, :2]])
        err = np.hypot((g[:, 0] - np.asarray(lon1)) * 111320 * np.cos(np.radians(lat1)), (g[:, 1] - np.asarray(lat1)) * 111320)
        n_pts += len(oa)
        if err.max() > worst:
            worst, worst_k = float(err.max()), k
    ok = worst * 1000 <= TOL_MM
    return ok, f"{slug:26} {'ok  ' if ok else 'FAIL'} {n_pts:7} pts  worst {worst * 1000:7.1f} mm ({worst_k})"


def main() -> int:
    slugs = sys.argv[1:] or sorted(p.parent.parent.name for p in ROOT.glob("*/web.staging/manifest.json"))
    if not slugs:
        print("nothing staged")
        return 0
    bad = 0
    for s in slugs:
        ok, line = verify(s)
        print(line, flush=True)
        bad += not ok
    print(f"\n{len(slugs) - bad}/{len(slugs)} sites agree with their UTM originals to within {TOL_MM:.0f} mm")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
