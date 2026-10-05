"""`osm.context`: the compact projection of osm.geojson the browser reads.

The viewer used to build its junction lane facts and its minimap roads by fetching and parsing the
whole raw extract on the main thread — 389 MB on the dc-metro world, where it froze at "junction
facts…". This pins the projection: lanes for every way (the junction model needs a row per road),
crossings for the crosswalk bisect, drawable roads for the minimap, and everything else dropped.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import osm  # noqa: E402


def _feat(fid, props, geom):
    return {"type": "Feature", "id": fid, "properties": {"osm_type": fid.split("/")[0], **props}, "geometry": geom}


FEATS = {
    "type": "FeatureCollection",
    "features": [
        _feat("way/1", {"highway": "primary", "lanes": "4", "lanes:forward": "2", "turn:lanes": "left|through"}, {"type": "LineString", "coordinates": [[-77.0, 38.9], [-77.001, 38.901]]}),
        _feat("way/2", {"highway": "motorway", "oneway": "yes"}, {"type": "LineString", "coordinates": [[-77.0, 38.9], [-77.002, 38.902]]}),
        _feat("way/3", {"highway": "footpath"}, {"type": "LineString", "coordinates": [[-77.0, 38.9], [-77.0, 38.91]]}),
        _feat("way/4", {"railway": "rail", "name": "CSX"}, {"type": "LineString", "coordinates": [[-77.0, 38.9], [-77.03, 38.93]]}),
        _feat("way/5", {"building": "yes"}, {"type": "Polygon", "coordinates": [[[0, 0], [0, 1], [1, 1], [0, 0]]]}),
        _feat("node/7", {"highway": "crossing"}, {"type": "Point", "coordinates": [-77.0005, 38.9005]}),
        _feat("node/8", {"highway": "crossing", "crossing": "unmarked"}, {"type": "Point", "coordinates": [-77.0006, 38.9006]}),
    ],
}


class OsmContextTest(unittest.TestCase):
    def test_projects_lanes_crossings_and_drawable_roads(self):
        ctx = osm.context(FEATS)

        # every way gets a lane row, keyed the way branches name it; footpath included (the viewer
        # looks up whatever road an approach names and falls back when it is absent)
        self.assertEqual(set(ctx["lanes"]), {"r1", "r2", "r3", "r4"})
        self.assertEqual(ctx["lanes"]["r1"]["lanes"], 4)
        self.assertEqual(ctx["lanes"]["r1"]["forward"], 2)
        self.assertEqual(ctx["lanes"]["r1"]["turn"], ["left", "through"])
        self.assertTrue(ctx["lanes"]["r2"]["oneway"])
        self.assertFalse(ctx["lanes"]["r1"]["oneway"])

        # crossings carry marked-ness; unmarked is the one flagged
        self.assertEqual([(c["lon"], c["marked"]) for c in ctx["crossings"]], [(-77.0005, True), (-77.0006, False)])

        # roads keep only the drawable classes, class resolved, name from name-or-ref
        self.assertEqual([(r["cls"], r["name"]) for r in ctx["roads"]], [("primary", None), ("motorway", None), ("railway", "CSX")])

    def test_write_context_round_trips_beside_osm_geojson(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            prov = osm.write_context(FEATS, out)
            self.assertEqual(prov, {"lanes": 4, "crossings": 2, "roads": 3})
            got = json.loads((out / "context.json").read_text())
            self.assertEqual(got["lanes"]["r1"]["lanes"], 4)


if __name__ == "__main__":
    unittest.main()
