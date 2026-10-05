"""buildings.derive: the POI→footprint containment must stay a lookup, not a scan.

dc-metro-take-2 spent 70 min in `buildings`, almost all of it a linear scan of 215,894 footprints
for each of 8,137 POIs (~1.76 billion `contains`). The STRtree replaced it; these tests pin that a
POI is still attributed to the footprint that actually contains it (and to none otherwise), which
is the only thing the lookup has to get right.

    tools/corridor/.venv/bin/python -m unittest discover -s tools/corridor/tests
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from corridor import buildings  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.6, 39.0


def _wgs(frame: Frame, x: float, y: float) -> list[float]:
    lon, lat = frame.to_wgs(x, y)
    return [round(float(lon), 8), round(float(lat), 8)]


def _poly(frame: Frame, cx: float, cy: float, r: float) -> dict:
    ring = [_wgs(frame, cx - r, cy - r), _wgs(frame, cx + r, cy - r), _wgs(frame, cx + r, cy + r), _wgs(frame, cx - r, cy + r), _wgs(frame, cx - r, cy - r)]
    return {"type": "Polygon", "coordinates": [ring]}


def _make_site(root: Path) -> Path:
    site = root / "site"
    site.mkdir(parents=True)
    frame = Frame.at(LON, LAT)
    ox, oy = frame.origin
    feats = [
        {"type": "Feature", "properties": {"building": "yes", "height": "12"}, "geometry": _poly(frame, ox + 20, oy + 20, 8)},
        {"type": "Feature", "properties": {"building": "yes"}, "geometry": _poly(frame, ox + 60, oy + 20, 8)},
        {"type": "Feature", "properties": {"amenity": "cafe", "name": "In"}, "geometry": {"type": "Point", "coordinates": _wgs(frame, ox + 20, oy + 20)}},
        {"type": "Feature", "properties": {"amenity": "bank", "name": "Out"}, "geometry": {"type": "Point", "coordinates": _wgs(frame, ox + 200, oy + 200)}},
    ]
    (site / "site.json").write_text(json.dumps({"slug": "t", "lon": LON, "lat": LAT, "frame": {"epsg": frame.epsg, "origin": list(frame.origin)}}))
    (site / "spine_utm.json").write_text(json.dumps({"coords": [[ox, oy], [ox + 100, oy]], "network": True}))
    (site / "osm.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return site


class DerivePoiTest(unittest.TestCase):
    def test_poi_is_attributed_to_the_footprint_that_contains_it(self):
        with tempfile.TemporaryDirectory() as d:
            out = buildings.derive(_make_site(Path(d)))
            self.assertEqual(out["summary"]["buildings"], 2)
            self.assertEqual(out["summary"]["pois"], 2)
            by_name = {p["name"]: p for p in out["pois"]}
            self.assertEqual(by_name["In"]["building"], 0)   # first footprint contains the cafe
            self.assertIsNone(by_name["Out"]["building"])     # the bank is in open ground

    def test_poi_tags_are_lent_to_its_building(self):
        with tempfile.TemporaryDirectory() as d:
            out = buildings.derive(_make_site(Path(d)))
            self.assertIn("amenity", out["buildings"][0]["tags"])


if __name__ == "__main__":
    unittest.main()
