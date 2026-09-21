"""What the road was blasted through: Macrostrat geologic map units along the spine.

Macrostrat merges state and national geologic maps at several scales and serves the units under a
point. Sampled every `step_m` along the corridor and de-duplicated by map unit, this is the list
of formations the cut faces expose — "Rockwell Formation: interbedded gray silty shale, light gray
to tan sandstone" is a prop brief in itself. The polygons at the photo point are saved too so the
unit boundaries can be drawn against the corridor.

Credit Macrostrat (CC-BY) wherever this is shown.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import requests
from shapely.geometry import LineString

from .geo import Frame

API = "https://macrostrat.org/api/v2/geologic_units/map"
session = requests.Session()
session.headers["User-Agent"] = "apex-conduit corridor (github.com/hotspoons)"
KEEP = ("map_id", "source_id", "name", "strat_name", "age", "lith", "descrip", "comments", "b_age", "t_age", "b_int_name", "t_int_name", "color")


def _get(params: dict, cache: Path):
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]
    hit = cache / "macrostrat" / f"{key}.json"
    if hit.exists():
        return json.loads(hit.read_text())
    r = session.get(API, params=params, timeout=90)
    r.raise_for_status()
    hit.parent.mkdir(parents=True, exist_ok=True)
    hit.write_bytes(r.content)
    return r.json()


def along_spine(spine: LineString, frame: Frame, site: dict, cache: Path, out_dir: Path, step_m: float = 250.0) -> dict:
    units: dict[int, dict] = {}
    samples = []
    for s in np.arange(0, spine.length + 1, step_m):
        x, y = spine.interpolate(min(s, spine.length)).coords[0]
        lon, lat = frame.to_wgs(x, y)
        data = _get({"lat": f"{lat:.5f}", "lng": f"{lon:.5f}"}, cache)["success"]["data"]
        ids = []
        for u in data:
            units.setdefault(u["map_id"], {k: u.get(k) for k in KEEP})
            ids.append(u["map_id"])
        samples.append({"s": round(float(s), 1), "map_ids": ids})
    gj = _get({"lat": f"{site['lat']:.5f}", "lng": f"{site['lon']:.5f}", "format": "geojson"}, cache)
    (out_dir / "geology.geojson").write_text(json.dumps(gj))
    # the most detailed sources are the ones that name a formation
    named = [u for u in units.values() if u.get("strat_name")]
    return {"units": list(units.values()), "named_formations": sorted({u["strat_name"] for u in named}), "samples": samples, "polygons": "geology.geojson", "credit": "Macrostrat (CC-BY)"}
