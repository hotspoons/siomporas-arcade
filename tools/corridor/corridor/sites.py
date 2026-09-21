"""Photos → sites.

A site is one place Rich stopped and took pictures. The phone writes the GPS fix it had at the
moment of the shutter, and on a moving car that fix lags: three frames a second apart share one
coordinate, and a frame a minute later can carry a fix from a kilometre back. So photos are
CLUSTERED (anything within `CLUSTER_M` of an existing site joins it), and the site's point is the
first fix in the cluster — a later correction is always "snap to the road", which osm.py does.

Names are assigned from the table below by nearest entry; the road itself is NOT named here,
because guessing "I-70" from a coordinate is exactly the kind of typing-instead-of-measuring that
bit the coast game. osm.py reads the ref off the nearest carriageway.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image

CLUSTER_M = 400.0

# Frames whose fix is not on the road they show. PXL_..._153447615 is a mirror shot of I-270 whose
# fix landed 2.4 m from New Design Road, a side street 800 m away — the phone had not caught up.
# Ignoring a frame is a judgement about the FIX, not the road; the road is still read from OSM.
IGNORE = {"PXL_20260920_153447615.jpg"}

# slug, lat, lon — the coordinates are the EXIF fixes of the first frame at each stop.
NAMES = [
    ("sideling-i68", 39.69994, -78.29780),
    ("south-mountain-i70", 39.46820, -77.52327),
    ("braddock-i70", 39.42259, -77.48652),
    ("frederick-i70", 39.39489, -77.41838),
    ("frederick-i270", 39.36466, -77.40011),
    ("clarksburg-i270", 39.18184, -77.25242),
    ("shady-grove-icc", 39.13691, -77.13168),
    ("burtonsville-icc", 39.07059, -76.91154),
    ("bowie-racetrack-rd", 39.01313, -76.75194),
]


def _dms(v) -> float:
    d, m, s = (float(x) for x in v)
    return d + m / 60 + s / 3600


def exif_fix(path: Path) -> dict | None:
    im = Image.open(path)
    ex = im.getexif()
    gps = ex.get_ifd(0x8825)
    if not gps or 2 not in gps or 4 not in gps:
        return None
    lat = _dms(gps[2]) * (-1 if gps.get(1) == "S" else 1)
    lon = _dms(gps[4]) * (-1 if gps.get(3) == "W" else 1)
    alt = float(gps[6]) if 6 in gps else None
    heading = float(gps[17]) if 17 in gps else None
    taken = ex.get_ifd(0x8769).get(36867) or ex.get(306)
    return {
        "file": path.name,
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "alt_m": alt,
        "heading_deg": heading,
        "taken": taken,
        "size": list(im.size),
    }


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_sites(photo_dir: Path) -> list[dict]:
    fixes = [f for f in (exif_fix(p) for p in sorted(photo_dir.glob("*.jpg")) if p.name not in IGNORE) if f]
    sites: list[dict] = []
    for f in fixes:
        for s in sites:
            if haversine_m(s["lat"], s["lon"], f["lat"], f["lon"]) <= CLUSTER_M:
                s["photos"].append(f)
                break
        else:
            sites.append({"lat": f["lat"], "lon": f["lon"], "photos": [f]})
    used: dict[str, int] = {}
    for s in sites:
        name, _ = min(
            ((n, haversine_m(s["lat"], s["lon"], la, lo)) for n, la, lo in NAMES), key=lambda t: t[1]
        )
        used[name] = used.get(name, 0) + 1
        s["slug"] = name if used[name] == 1 else f"{name}-{used[name]}"
        s["heading_deg"] = next((p["heading_deg"] for p in s["photos"] if p["heading_deg"] is not None), None)
    return sites


def main(photo_dir: Path, out: Path) -> None:
    sites = build_sites(photo_dir)
    out.write_text(json.dumps(sites, indent=2))
    for s in sites:
        print(f"{s['slug']:24s} {s['lat']:.5f} {s['lon']:.5f}  {len(s['photos'])} photo(s)  heading {s['heading_deg']}")
    print(f"{len(sites)} sites -> {out}")
