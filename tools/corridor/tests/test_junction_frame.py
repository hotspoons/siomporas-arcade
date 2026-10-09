"""A junction is placed from what its record MEANS, under whatever frame the export holds.

`junctions[].x/y` in spine_utm.json and branches.json are ENU metres about the origin the file
was written with, and crofton-triangle's origin moved 1.14 km between its vectors (2026-09-26,
sites.json's centre) and its site.json (2026-10-02, the world editor's). `export_site` builds its
frame from site.json, so a re-export read one origin's metres as the other's: every junction
1,082 m from its road, the viewer's junction meet finding nothing. Three on-read "repairs"
preceded `network.place_junctions`, each measuring something other than the input's frame.

These pin the rule that replaced them: the position is the node's lon/lat (every file written
since), else the chain's own absolute-UTM polyline at `s` (every file before), and a junction
that still does not land on its own road is a FrameFault, not a note. The export under a frame
a kilometre from the one the file was written in must agree with the export under the file's
own frame to the rounding, and exporting twice is exporting once.

    tools/corridor/.venv/bin/python -m unittest tests.test_junction_frame
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, Point, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import network  # noqa: E402
from corridor.geo import Frame  # noqa: E402

LON, LAT = -76.685, 39.007
FRAME_A = Frame.at(LON, LAT)                                               # the frame the vectors were written in
FRAME_B = Frame(FRAME_A.epsg, (FRAME_A.origin[0] + 1072.0, FRAME_A.origin[1] + 397.0))  # crofton-triangle's site.json, 1.14 km away
OX, OY = FRAME_A.origin


def _junction(frame: Frame, chain: LineString, x_utm: float, y_utm: float, node: int, with_: list[str], authority: bool) -> dict:
    """One junction record as `network.roads` writes it (x/y about `frame`; lon/lat when `authority`)."""
    e, n = frame.to_enu(x_utm, y_utm)
    j = {"node": node, "x": round(float(e), 1), "y": round(float(n), 1), "s": round(float(chain.project(Point(x_utm, y_utm))), 1), "with": with_}
    if authority:
        lon, lat = frame.to_wgs(x_utm, y_utm)
        j["lon"], j["lat"] = round(float(lon), 7), round(float(lat), 7)
    return j


def _site(frame: Frame, authority: bool, tag) -> tempfile.TemporaryDirectory:
    """A primary running east and one branch crossing it, written as `network.roads` would under `frame`."""
    prim = LineString([(OX - 1500.0 + 10.0 * i, OY) for i in range(301)])      # 3 km of primary, a vertex every 10 m
    br = LineString([(OX + 400.0, OY - 800.0 + 10.0 * i) for i in range(161)])   # a 1.6 km side street, north-south
    node_x, node_y = OX + 400.0, OY                                              # the shared node, a vertex of both
    tmp = tempfile.TemporaryDirectory()
    d = Path(tmp.name)
    sib = {
        "osm_ids": [2], "tags": {"highway": "residential"}, "geometry": mapping(br), "id": "r2", "name": "Side St", "ref": None,
        "ident": "Side St", "highway": "residential", "lanes": 2, "oneway": "no", "length_m": br.length,
        "junctions": [_junction(frame, br, node_x, node_y, 7, ["Main St"], authority)], "dead_ends": [],
    }
    d.joinpath("spine_utm.json").write_text(json.dumps({
        "epsg": frame.epsg, "coords": np.array(prim.coords).round(2).tolist(), "photo_s": 1500.0, "segments": [], "siblings": [sib],
        "network": True, "primary": {"id": "r1", "ident": "Main St", "length_m": prim.length, "junctions": [_junction(frame, prim, node_x, node_y, 7, ["Side St"], authority)], "dead_ends": []},
        "roads": ["Main St", "Side St"],
    }))
    branches = [{"id": "r2", "ident": "Side St", "name": "Side St", "ref": None, "highway": "residential", "lanes": 2, "oneway": "no", "length_m": br.length,
                 "s_on_primary": 1900.0, "junctions": sib["junctions"], "dead_ends": [], "profile": None, "structures": []}]
    d.joinpath("branches.json").write_text(network.branches_doc(branches, tag))
    return tmp


def _off_road(branches: list[dict]) -> float:
    """The worst distance of any exported junction from its own branch's exported coords."""
    worst = 0.0
    for b in branches:
        c = np.asarray(b["coords"], dtype=float)
        for j in b["junctions"]:
            worst = max(worst, float(np.hypot(c[:, 0] - j["x"], c[:, 1] - j["y"]).min()))
    return worst


class JunctionsFollowTheExportFrame(unittest.TestCase):
    """The same file, exported under its own frame and under one 1.14 km away, puts the junction on the road both times."""

    def test_a_current_file_places_from_lon_lat_under_any_frame(self):
        with _site(FRAME_A, authority=True, tag=FRAME_A) as tmp:
            own = network.export_branches(Path(tmp), FRAME_A)
            moved = network.export_branches(Path(tmp), FRAME_B)
        self.assertLess(_off_road(own), 0.1)
        self.assertLess(_off_road(moved), 0.1)
        # the two exports differ by the frame change of the WHOLE road, so compare each junction
        # to its road, not to the other export: both are on it, and FRAME_B's origin is 1.14 km off
        self.assertGreater(abs(own[0]["junctions"][0]["x"] - moved[0]["junctions"][0]["x"]), 1000.0)

    def test_a_file_from_before_lon_lat_places_from_its_own_polyline(self):
        # the Sep-26 shape: `"frame": "enu"`, x/y about FRAME_A, no lon/lat — the whole on-disk crofton-triangle
        with _site(FRAME_A, authority=False, tag="enu") as tmp:
            moved = network.export_branches(Path(tmp), FRAME_B)
        self.assertLess(_off_road(moved), 0.1)

    def test_reading_twice_is_reading_once(self):
        with _site(FRAME_A, authority=True, tag=FRAME_A) as tmp:
            first = json.dumps(network.export_branches(Path(tmp), FRAME_B), sort_keys=True)
            second = json.dumps(network.export_branches(Path(tmp), FRAME_B), sort_keys=True)
        self.assertEqual(first, second)

    def test_the_file_carries_the_frame_it_was_written_in(self):
        with _site(FRAME_A, authority=True, tag=FRAME_A) as tmp:
            tag = json.loads(Path(tmp, "branches.json").read_text())["frame"]
        self.assertEqual(tag["kind"], "enu")
        self.assertEqual(tag["epsg"], FRAME_A.epsg)
        np.testing.assert_allclose(tag["origin"], FRAME_A.origin)


class AJunctionOffItsRoadIsAFault(unittest.TestCase):
    """A record that cannot be placed on its road stops the export with the numbers, instead of shipping."""

    def test_a_stored_pair_in_the_wrong_frame_is_refused(self):
        with _site(FRAME_A, authority=False, tag="enu") as tmp:
            # strip `s` too: nothing is left but x/y about FRAME_A, read under FRAME_B
            p = Path(tmp, "branches.json")
            doc = json.loads(p.read_text())
            for b in doc["branches"]:
                for j in b["junctions"]:
                    j.pop("s", None)
            p.write_text(json.dumps(doc))
            with self.assertRaises(network.FrameFault) as cm:
                network.export_branches(Path(tmp), FRAME_B)
        self.assertIn("m from its own road", str(cm.exception))

    def test_the_primary_is_placed_too(self):
        # export.py places the primary's junctions through the same function, from spine_utm's coords
        with _site(FRAME_A, authority=False, tag="enu") as tmp:
            sp = json.loads(Path(tmp, "spine_utm.json").read_text())
        placed = network.place_junctions(FRAME_B, sp["primary"]["junctions"], sp["coords"], what="the primary")
        e, n = FRAME_B.to_enu([c[0] for c in sp["coords"]], [c[1] for c in sp["coords"]])
        d = float(np.hypot(np.asarray(e) - placed[0]["x"], np.asarray(n) - placed[0]["y"]).min())
        self.assertLess(d, 0.1)
        self.assertIsInstance(network.FrameFault(), network.BakeFault)


if __name__ == "__main__":
    unittest.main()
