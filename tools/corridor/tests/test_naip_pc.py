"""NAIP from the Planetary Computer, with the USGS ImageServer behind it.

2026-10-10: the ImageServer answered 504 for an hour and killed two dc-metro bakes; Rich asked
whether the open data could stand in for the API. The Planetary Computer's `naip` collection is the
same USDA imagery as COGs, found by STAC search. These tests drive `naip.py`/`naip_pc.py` against a
fake catalogue and tiny local COGs the tests write themselves — no network at all.

What they pin:
  * item choice: newest year first, the finer item within a year, the older ones only in holes,
    and an item nobody needs is never read (a state line, a black collar, a 2018 nobody wants);
  * registration: a marker lands on the pixel its coordinates say, through the overview read;
  * failure modes: a 5xx that recovers; an outage that does not (BakeFault, never Sentinel-2);
    an empty search WITH a full control (Sentinel-2); an empty control (not an answer);
    PC down while USGS is up (USGS serves); the SAS token refreshed near its expiry;
  * the cache: a second run reads nothing.

Plain unittest + unittest.mock: the image's CI runs `python -m unittest discover -s tests` with
only tests/ mounted.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import rasterio
import rasterio.shutil
from PIL import Image
from rasterio.transform import from_origin
from shapely.geometry import box, mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import BakeFault, naip, naip_pc  # noqa: E402
from corridor.geo import Frame  # noqa: E402

FRAME = Frame(32618, (355000.0, 4318000.0))
AREA = (355000.0, 4318000.0, 355600.0, 4318600.0)  # 600 m at 0.6 m = 1000 px

RED, GREEN, BLUE, YELLOW = (200, 10, 10), (10, 200, 10), (10, 10, 200), (250, 250, 0)


NIR = 77
RGBN = ("red", "green", "blue", "undefined")


def write_cog(path: Path, ubox, res: float, colour, hole=None, crs="EPSG:26918", marker=None, white=(), order=RGBN) -> None:
    """A 4-band (RGB+NIR, like NAIP) COG of one flat colour over a UTM box, with an optional
    all-zero `hole` box (a quarter-quad's black collar) and an optional white `marker` box. Band 4
    is NIR with an UNDEFINED colour interpretation, exactly as the real NAIP COGs have it (not
    alpha); `order` names the colour interpretation of each stored band ("undefined" is NIR)."""
    x0, y0, x1, y1 = ubox
    w, h = int(round((x1 - x0) / res)), int(round((y1 - y0) / res))
    value = {"red": colour[0], "green": colour[1], "blue": colour[2], "undefined": NIR}
    a = np.empty((4, h, w), dtype=np.uint8)
    for b, name in enumerate(order):
        a[b] = value[name]
    if hole is not None:
        hx0, hy0, hx1, hy1 = hole
        a[:, int((y1 - hy1) / res) : int((y1 - hy0) / res), int((hx0 - x0) / res) : int((hx1 - x0) / res)] = 0
    rgb = [order.index(c) for c in ("red", "green", "blue")]
    for wx0, wy0, wx1, wy1 in white:
        a[rgb, int(round((y1 - wy1) / res)) : int(round((y1 - wy0) / res)), int(round((wx0 - x0) / res)) : int(round((wx1 - x0) / res))] = 255
    if marker is not None:
        mx0, my0, mx1, my1 = marker
        a[rgb, int(round((y1 - my1) / res)) : int(round((y1 - my0) / res)), int(round((mx0 - x0) / res)) : int(round((mx1 - x0) / res))] = 255
    tmp = path.with_suffix(".plain.tif")
    from rasterio.enums import ColorInterp

    with rasterio.open(tmp, "w", driver="GTiff", width=w, height=h, count=4, dtype="uint8", crs=crs,
                       transform=from_origin(x0, y1, res, res), tiled=True, blockxsize=256, blockysize=256,
                       photometric="MINISBLACK", alpha="UNSPECIFIED") as dst:
        dst.write(a)
        dst.colorinterp = [getattr(ColorInterp, n) for n in order]
    rasterio.shutil.copy(tmp, path, driver="COG", OVERVIEWS="AUTO", OVERVIEW_RESAMPLING="AVERAGE", BLOCKSIZE=256)
    tmp.unlink()


EO_RGBN = [{"name": "Red", "common_name": "red"}, {"name": "Green", "common_name": "green"},
           {"name": "Blue", "common_name": "blue"}, {"name": "NIR", "common_name": "nir"}]


def feature(fid: str, href: Path, ubox, year: int, gsd: float, state: str, date: str | None = None, eo_bands=EO_RGBN) -> dict:
    lon, lat = FRAME.to_wgs(np.array([ubox[0], ubox[2], ubox[2], ubox[0]]), np.array([ubox[1], ubox[1], ubox[3], ubox[3]]))
    ring = [[float(x), float(y)] for x, y in zip(lon, lat)] + [[float(lon[0]), float(lat[0])]]
    return {
        "id": fid,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "bbox": [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())],
        "properties": {"datetime": f"{date or f'{year}-07-01'}T16:00:00Z", "naip:year": str(year), "naip:state": state, "gsd": gsd},
        "assets": {"image": {"href": str(href), **({"eo:bands": eo_bands} if eo_bands is not None else {})}},
    }


class FakeCatalogue:
    """`naip_pc._http_json` stand-in: STAC search by bbox intersection, a token endpoint, and a
    queue of failures to inject. Counts every call."""

    def __init__(self, features: list[dict], control: bool = True):
        self.features = features
        self.control = control
        self.fail: list[Exception] = []
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method, url, body=None, timeout=120):
        self.calls.append((method, url))
        if self.fail:
            raise self.fail.pop(0)
        if url.endswith("/token/naip"):
            return {"msft:expiry": "2099-01-01T00:00:00Z", "token": "sig=fake"}
        q = box(*body["bbox"])
        if tuple(body["bbox"]) == tuple(round(v, 6) for v in naip_pc.CONTROL_BBOX):
            return {"type": "FeatureCollection", "features": [{"id": "control"}] if self.control else [], "links": []}
        return {"type": "FeatureCollection", "features": [f for f in self.features if box(*f["bbox"]).intersects(q)], "links": []}


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.cache = self.dir / "cache"
        naip_pc._SEARCHED.clear()
        self.env = mock.patch.dict(os.environ, {"CORRIDOR_NAIP_SOURCE": "auto", "CORRIDOR_NAIP_JOBS": "2"})
        self.env.start()
        self.sleeps: list[float] = []
        self.sleep = mock.patch("time.sleep", lambda s: self.sleeps.append(s))
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.env.stop()
        naip_pc._SEARCHED.clear()
        self.tmp.cleanup()

    def usgs_never(self):
        """Patch the ImageServer so any call fails the test: these cases must not need it."""
        def boom(*a, **k):
            raise AssertionError("the USGS ImageServer was asked")
        return mock.patch.object(naip, "_get_with_retry", boom)


class ItemChoiceTest(_Base):
    """Across a state line: VA 2023 (0.6 m) to the west, MD 2023 (0.3 m) to the east with a black
    collar in its north-east corner, MD 2021 under all of it, and a 2018 under all of it too."""

    def setUp(self):
        super().setUp()
        d = self.dir
        write_cog(d / "va23.tif", (354900, 4317900, 355310, 4318700), 0.6, RED)
        write_cog(d / "md23.tif", (355290, 4317900, 355700, 4318700), 0.3, GREEN, hole=(355500, 4318450, 355700, 4318700))
        write_cog(d / "md21.tif", (354900, 4317900, 355700, 4318700), 0.6, BLUE)
        write_cog(d / "md18.tif", (354900, 4317900, 355700, 4318700), 1.0, YELLOW)
        self.cat = FakeCatalogue([
            feature("md_2018", d / "md18.tif", (354900, 4317900, 355700, 4318700), 2018, 1.0, "md"),
            feature("md_2021", d / "md21.tif", (354900, 4317900, 355700, 4318700), 2021, 0.6, "md"),
            feature("va_2023", d / "va23.tif", (354900, 4317900, 355310, 4318700), 2023, 0.6, "va"),
            feature("md_2023", d / "md23.tif", (355290, 4317900, 355700, 4318700), 2023, 0.3, "md"),
        ])

    def bake(self):
        from corridor import network_tiles

        out = self.dir / "naip_1m.tif"
        with mock.patch.object(naip_pc, "_http_json", self.cat), self.usgs_never(), mock.patch.object(naip, "TILE_PX", 500):
            meta = network_tiles.naip_tiled(FRAME, AREA, box(*AREA), out, self.cache, res=0.6)
        return out, meta

    def px(self, ds, x, y):
        r, c = ds.index(x, y)
        return tuple(int(v) for v in ds.read(window=rasterio.windows.Window(c, r, 1, 1))[:, 0, 0])

    def assertNear(self, got, want, tol=12):  # JPEG twice (the cached piece, the GeoTIFF)
        self.assertTrue(all(abs(g - w) <= tol for g, w in zip(got, want)), f"{got} is not {want}")

    def test_newest_first_with_gap_fill_across_a_state_line(self):
        out, meta = self.bake()
        with rasterio.open(out) as ds:
            self.assertEqual((ds.width, ds.height), (1000, 1000))
            self.assertEqual(ds.res, (0.6, 0.6))
            self.assertNear(self.px(ds, 355100, 4318300), RED)     # Virginia 2023
            self.assertNear(self.px(ds, 355420, 4318100), GREEN)   # Maryland 2023
            self.assertNear(self.px(ds, 355300, 4318100), GREEN)   # the overlap: same year, the 0.3 m item wins
            self.assertNear(self.px(ds, 355580, 4318580), BLUE)    # MD 2023's collar, filled from 2021
            rgb = ds.read()
        # 2018 is never needed, so it never shows — and nothing is left black
        self.assertFalse(((np.abs(rgb[0].astype(int) - 250) < 20) & (np.abs(rgb[2].astype(int) - 0) < 20)).any())
        self.assertFalse((rgb <= naip.NAIP_BLANK_MAX).all(axis=0).any())
        self.assertEqual(meta["blank_tiles"], 0)
        self.assertEqual(meta["res_m"], 0.6)
        self.assertEqual(meta["tiles_by_source"], {"pc": 4})
        ids = [r["id"] for r in meta["items"]]
        self.assertEqual(ids, ["md_2023", "va_2023", "md_2021"])  # newest first, finer first, 2018 absent
        self.assertEqual(meta["years"], [2023, 2021])
        self.assertEqual(meta["source_res_m"], [0.3, 0.6])
        self.assertIn("Planetary Computer", meta["source"])

    def test_a_rerun_reads_nothing(self):
        self.bake()
        (self.dir / "naip_1m.tif").unlink()  # the raster goes; the cached pieces stay
        naip_pc._SEARCHED.clear()
        before = len(self.cat.calls)
        with mock.patch.object(naip_pc, "warp_item", side_effect=AssertionError("re-read a cached piece")):
            _out, meta = self.bake()
        searches = [c for c in self.cat.calls[before:] if c[1].endswith("/search")]
        self.assertEqual(len(searches), 1, "only the coverage probe; the tiles are all cached")
        self.assertEqual(meta["tiles_by_source"], {"pc": 4})
        self.assertEqual([r["id"] for r in meta["items"]], ["md_2023", "va_2023", "md_2021"])

    def test_a_changed_rule_does_not_reuse_old_pieces(self):
        self.bake()
        (self.dir / "naip_1m.tif").unlink()
        naip_pc._SEARCHED.clear()
        reads: list[str] = []
        real = naip_pc.warp_item
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_LEAF_ON_YEARS": "0"}), \
                mock.patch.object(naip_pc, "warp_item", lambda it, *a, **k: reads.append(it.id) or real(it, *a, **k)):
            _out, meta = self.bake()
        self.assertTrue(reads, "pieces composed under the old rule were reused")
        self.assertIn("0 years newer", meta["rule"])

    def test_the_2018_item_is_never_opened(self):
        opened: list[str] = []
        real = naip_pc.warp_item

        def spy(item, *a, **k):
            opened.append(item.id)
            return real(item, *a, **k)

        with mock.patch.object(naip_pc, "warp_item", spy):
            self.bake()
        self.assertNotIn("md_2018", opened)
        self.assertIn("md_2021", opened)  # but the hole did pull in the next-newest

    def test_rank_order(self):
        items = sorted((naip_pc.item_from_feature(f) for f in self.cat.features), key=naip_pc.Item.rank_key)
        self.assertEqual([i.id for i in items], ["md_2023", "va_2023", "md_2021", "md_2018"])


class RedactionTest(_Base):
    def test_a_white_redaction_is_a_hole_and_a_white_roof_is_not(self):
        # md_m_3807708_ne 2023 carries a 0.9 x 1.3 km block of pure white near -77.06, 38.945; the
        # older item under it has ground. A small saturated roof in the same item must stay.
        d = self.dir
        # a 150 x 150 m redaction and a 12 m white roof
        write_cog(d / "new.tif", (354900, 4317900, 355700, 4318700), 0.6, GREEN,
                  white=[(355100, 4318250, 355250, 4318400), (355450, 4318188, 355462, 4318200)])
        write_cog(d / "old.tif", (354900, 4317900, 355700, 4318700), 0.6, BLUE)
        items = sorted((naip_pc.item_from_feature(f) for f in (
            feature("old", d / "old.tif", (354900, 4317900, 355700, 4318700), 2021, 0.6, "md"),
            feature("new", d / "new.tif", (354900, 4317900, 355700, 4318700), 2023, 0.6, "md"),
        )), key=naip_pc.Item.rank_key)
        arr, used = naip_pc.compose(FRAME, AREA, 0.6, items)
        px = lambda x, y: tuple(int(v) for v in arr[:, int((AREA[3] - y) / 0.6), int((x - AREA[0]) / 0.6)])
        self.assertEqual(px(355175, 4318325), BLUE)            # inside the redaction: the 2021 ground
        self.assertEqual(px(355456, 4318194), (255, 255, 255))  # the roof is kept
        self.assertEqual(px(355400, 4318500), GREEN)
        self.assertEqual([u.id for u in used], ["new", "old"])


class BandLayoutTest(_Base):
    """The bands are NAMED, never assumed to be 1, 2, 3 (coordinator review, 2026-10-10)."""

    def _read(self, order, eo_bands):
        write_cog(self.dir / "b.tif", (354900, 4317900, 355700, 4318700), 0.6, RED, order=order)
        item = naip_pc.item_from_feature(feature("b", self.dir / "b.tif", (354900, 4317900, 355700, 4318700), 2023, 0.6, "md", eo_bands=eo_bands))
        arr, used = naip_pc.compose(FRAME, AREA, 0.6, [item])
        return tuple(int(v) for v in arr[:, 500, 500]), [u.id for u in used]

    def test_a_nir_first_layout_is_read_by_name(self):
        nir_first = [EO_RGBN[3], *EO_RGBN[:3]]
        self.assertEqual(naip_pc.rgb_bands({"eo:bands": nir_first}), (2, 3, 4))
        px, used = self._read(("undefined", "red", "green", "blue"), nir_first)
        self.assertEqual(px, RED)  # read as bands 1-3 this is (NIR, R, G) = (77, 200, 10): false colour
        self.assertEqual(used, ["b"])

    def test_the_file_alone_can_name_the_bands(self):
        px, used = self._read(("blue", "green", "red", "undefined"), None)
        self.assertEqual(px, RED)

    def test_catalogue_and_file_disagreeing_is_never_painted(self):
        px, used = self._read(("blue", "green", "red", "undefined"), EO_RGBN)
        self.assertEqual(px, (0, 0, 0))  # a hole the tile report names, not swapped colours
        self.assertEqual(used, [])

    def test_a_cir_product_is_not_a_candidate(self):
        cir = [{"common_name": "nir"}, {"common_name": "red"}, {"common_name": "green"}]
        with self.assertRaises(naip_pc.BandLayoutError):
            naip_pc.rgb_bands({"eo:bands": cir})
        write_cog(self.dir / "c.tif", (354900, 4317900, 355700, 4318700), 0.6, RED)
        cat = FakeCatalogue([feature("cir", self.dir / "c.tif", (354900, 4317900, 355700, 4318700), 2023, 0.6, "md", eo_bands=cir)])
        with mock.patch.object(naip_pc, "_http_json", cat):
            self.assertEqual(naip_pc.search(FRAME.bbox_wgs(*AREA)), [])


class LeafOnTest(unittest.TestCase):
    """Virginia 2023 was flown Oct-Nov; 2021 on 09-10. Rich cares how it looks (2026-10-10)."""

    def item(self, iid, date, gsd=0.6):
        return naip_pc.Item(iid, f"/x/{iid}.tif", date, int(date[:4]), iid[:2], gsd, box(0, 0, 1, 1))

    def order(self, *items):
        return [i.id for i in sorted(items, key=naip_pc.Item.rank_key)]

    def test_leaf_on_two_years_older_beats_a_november_flight(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CORRIDOR_NAIP_LEAF_ON", None)
            os.environ.pop("CORRIDOR_NAIP_LEAF_ON_YEARS", None)
            va23 = self.item("va_2023_nov", "2023-11-13")
            va21 = self.item("va_2021_sep", "2021-09-10")
            md23 = self.item("md_2023_sep", "2023-09-01", 0.3)
            md21 = self.item("md_2021_jun", "2021-06-17")
            self.assertEqual(self.order(va23, va21, md23, md21), ["md_2023_sep", "va_2021_sep", "md_2021_jun", "va_2023_nov"])
            # three years is past the window: the newer leaf-off flight wins again
            self.assertEqual(self.order(va23, self.item("va_2020_jul", "2020-07-01")), ["va_2023_nov", "va_2020_jul"])
            self.assertTrue(va21.record()["leaf_on"])
            self.assertFalse(va23.record()["leaf_on"])

    def test_the_rule_is_configurable(self):
        va23 = self.item("va_2023_nov", "2023-11-13")
        va21 = self.item("va_2021_sep", "2021-09-10")
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_LEAF_ON_YEARS": "0"}):
            self.assertEqual(self.order(va23, va21), ["va_2023_nov", "va_2021_sep"])
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_LEAF_ON": "5-11"}):
            self.assertEqual(self.order(va23, va21), ["va_2023_nov", "va_2021_sep"])  # November counts as leaf-on
            self.assertIn("months 5-11", naip_pc.ranking_rule())


PURPLE, ORANGE, GREY = (120, 40, 160), (230, 120, 20), (90, 90, 90)
WEST, EAST, ALL = (354900, 4317900, 355300, 4318700), (355300, 4317900, 355700, 4318700), (354900, 4317900, 355700, 4318700)


class OneYearTest(_Base):
    """Rich, 2026-10-10: "prefer one year everywhere". The newest year whose LEAF-ON items cover the
    whole area, that year only, then the rest only into holes."""

    def cat(self, *specs):
        feats = []
        for fid, ubox, date, colour, kw in specs:
            write_cog(self.dir / f"{fid}.tif", ubox, 0.6, colour, **kw)
            feats.append(feature(fid, self.dir / f"{fid}.tif", ubox, int(date[:4]), 0.6, fid[:2], date=date))
        return FakeCatalogue(feats)

    def bake(self, cat, env=None):
        from corridor import network_tiles

        out = self.dir / "naip_1m.tif"
        if out.exists():
            out.unlink()
        naip_pc._SEARCHED.clear()
        with mock.patch.dict(os.environ, env or {}), mock.patch.object(naip_pc, "_http_json", cat), self.usgs_never():
            meta = network_tiles.naip_tiled(FRAME, AREA, box(*AREA), out, self.cache, res=0.6)
        with rasterio.open(out) as ds:
            west = tuple(int(v) for v in ds.read(window=rasterio.windows.Window(100, 500, 1, 1))[:, 0, 0])
            east = tuple(int(v) for v in ds.read(window=rasterio.windows.Window(800, 500, 1, 1))[:, 0, 0])
            corner = tuple(int(v) for v in ds.read(window=rasterio.windows.Window(950, 50, 1, 1))[:, 0, 0])
        return meta, west, east, corner

    def near(self, got, want, tol=12):
        return all(abs(g - w) <= tol for g, w in zip(got, want))

    def two_states(self, md21_kw=None):
        # MD flew 2023 in July (leaf-on), VA flew 2023 in November (leaf-off); both flew 2021 leaf-on
        return self.cat(
            ("md_2023", EAST, "2023-07-12", GREEN, {}),
            ("va_2023", WEST, "2023-11-13", ORANGE, {}),
            ("md_2021", EAST, "2021-06-17", BLUE, md21_kw or {}),
            ("va_2021", WEST, "2021-09-10", PURPLE, {}),
        )

    def test_two_states_pick_the_older_year_that_covers_both(self):
        meta, west, east, _ = self.bake(self.two_states())
        self.assertEqual(meta["year"]["year"], 2021)
        self.assertEqual(meta["year"]["coverage"]["by_state"], {"md": 0.5, "va": 0.5})
        self.assertIn("2023 covers 50.0%", meta["year"]["why"])
        self.assertTrue(self.near(west, PURPLE), west)
        self.assertTrue(self.near(east, BLUE), east)  # not MD's newer 2023: one year everywhere
        self.assertIn("one year: 2021", meta["rule"])

    def test_one_state_keeps_the_newest(self):
        cat = self.cat(("md_2023", ALL, "2023-07-12", GREEN, {}), ("md_2021", ALL, "2021-06-17", BLUE, {}))
        meta, west, east, _ = self.bake(cat)
        self.assertEqual(meta["year"]["year"], 2023)
        self.assertTrue(self.near(west, GREEN) and self.near(east, GREEN))

    def test_a_forced_year(self):
        cat = self.cat(("md_2023", ALL, "2023-07-12", GREEN, {}), ("md_2021", ALL, "2021-06-17", BLUE, {}))
        meta, west, east, _ = self.bake(cat, {"CORRIDOR_NAIP_YEAR": "2021"})
        self.assertEqual(meta["year"]["year"], 2021)
        self.assertIn("forced", meta["year"]["why"])
        self.assertTrue(self.near(west, BLUE) and self.near(east, BLUE))

    def test_off_is_the_per_pixel_ranking(self):
        meta, west, east, _ = self.bake(self.two_states(), {"CORRIDOR_NAIP_YEAR": "off"})
        self.assertIsNone(meta["year"]["year"])
        self.assertTrue(self.near(east, GREEN), east)   # MD 2023, newest leaf-on
        self.assertTrue(self.near(west, PURPLE), west)  # VA 2021 leaf-on beats VA 2023 November

    def test_other_years_fill_only_the_holes(self):
        # MD 2021 has a black collar in its north-east corner; only there does MD 2023 show
        meta, west, east, corner = self.bake(self.two_states({"hole": (355500, 4318450, 355700, 4318700)}))
        self.assertEqual(meta["year"]["year"], 2021)
        self.assertTrue(self.near(east, BLUE), east)
        self.assertTrue(self.near(corner, GREEN), corner)
        self.assertIn("md_2023", [r["id"] for r in meta["items"]])  # as gap fill only (the corner)

    def test_no_year_covers_falls_back_and_says_so(self):
        cat = self.cat(("md_2023", EAST, "2023-07-12", GREEN, {}), ("va_2021", WEST, "2021-09-10", PURPLE, {}))
        meta, west, east, _ = self.bake(cat)
        self.assertIsNone(meta["year"]["year"])
        self.assertIn("per-pixel", meta["year"]["why"])
        self.assertTrue(self.near(west, PURPLE) and self.near(east, GREEN))

    def test_water_outside_every_item_does_not_count_against_a_year(self):
        # only the west half has NAIP at all (the east is the bay): 2023 covers all that any year does
        cat = self.cat(("md_2023", WEST, "2023-07-12", GREEN, {}), ("md_2021", WEST, "2021-06-17", BLUE, {}))
        meta, west, _e, _c = self.bake(cat)
        self.assertEqual(meta["year"]["year"], 2023)

    def test_the_year_is_in_the_cache_name(self):
        tiles = {}
        for tag in ("y2021", "y2023"):
            pol = naip_pc.YearPolicy(int(tag[1:]), "test")
            tiles[tag] = naip.plan_tiles(FRAME, AREA, 0.6, self.cache, policy=pol)[0][2].pc.name
        self.assertNotEqual(tiles["y2021"], tiles["y2023"])
        self.assertTrue(tiles["y2021"].endswith("y2021.jpg"))


class RegistrationTest(_Base):
    def test_a_marker_lands_where_its_coordinates_say_through_the_overview(self):
        # A 0.3 m source in NAD83 read for a 0.6 m lattice in WGS84 UTM goes through the 2x overview
        # and a warp. A 6 m white square's brightness-weighted centre must land within a quarter of
        # an output pixel (0.1 m) of where its corners say: a half-pixel slip (0.3 m), a flipped axis or a
        # row/column swap all fail this (the half-pixel one was tried, 2026-10-10).
        sq = (355120.2, 4318319.9, 355126.2, 4318325.9)  # on the 0.3 m source grid
        write_cog(self.dir / "m.tif", (354900, 4317900, 355700, 4318700), 0.3, (60, 60, 60), marker=sq)
        item = naip_pc.item_from_feature(feature("m", self.dir / "m.tif", (354900, 4317900, 355700, 4318700), 2023, 0.3, "md"))
        arr, used = naip_pc.compose(FRAME, AREA, 0.6, [item])
        self.assertEqual([u.id for u in used], ["m"])
        wgt = np.clip(arr.astype(float).mean(axis=0) - 60.0, 0, None)
        r, c = np.indices(wgt.shape)
        cx = AREA[0] + ((c + 0.5) * wgt).sum() / wgt.sum() * 0.6
        cy = AREA[3] - ((r + 0.5) * wgt).sum() / wgt.sum() * 0.6
        self.assertLess(abs(cx - (sq[0] + sq[2]) / 2), 0.1)
        self.assertLess(abs(cy - (sq[1] + sq[3]) / 2), 0.1)

    def test_overview_level_choice(self):
        self.assertEqual(naip_pc.overview_level(0.3, [2, 4, 8, 16, 32, 64], 0.6), 0)
        self.assertIsNone(naip_pc.overview_level(0.6, [2, 4, 8], 0.6))
        self.assertIsNone(naip_pc.overview_level(0.6, [2, 4, 8], 0.3))
        self.assertEqual(naip_pc.overview_level(0.3, [2, 4, 8, 16, 32, 64], 60.0), 5)


class FailureModeTest(_Base):
    def setUp(self):
        super().setUp()
        write_cog(self.dir / "a.tif", (354900, 4317900, 355700, 4318700), 0.6, GREEN)
        self.cat = FakeCatalogue([feature("md_2023", self.dir / "a.tif", (354900, 4317900, 355700, 4318700), 2023, 0.6, "md")])

    def test_a_5xx_outage_that_recovers(self):
        self.cat.fail = [RuntimeError("HTTP 503"), RuntimeError("HTTP 504"), RuntimeError("HTTP 502")]
        with mock.patch.object(naip_pc, "_http_json", self.cat), self.usgs_never():
            self.assertIs(naip.covered(FRAME, AREA), True)
        self.assertEqual(self.sleeps, [10, 20, 40])

    def test_an_outage_that_does_not_recover_is_a_fault_not_sentinel(self):
        # Both sources down. The old probe would have read this as "not covered" before
        # e4de399; now it must stop the bake, and fetch_naip must never reach Sentinel-2.
        self.cat.fail = [RuntimeError("HTTP 504")] * 100

        def usgs_down(*a, **k):
            raise RuntimeError("https://imagery.nationalmap.gov/...: HTTP 504")

        out = self.dir / "naip.tif"
        with mock.patch.object(naip_pc, "_http_json", self.cat), mock.patch.object(naip, "_get_with_retry", usgs_down), \
                mock.patch.object(naip, "fetch_sentinel2", side_effect=AssertionError("dropped to Sentinel-2 on an outage")):
            with self.assertRaises(BakeFault):
                naip.fetch_naip(FRAME, AREA, out, self.cache)
        self.assertFalse(out.exists())
        # the catalogue was given its (short, because USGS stands behind it) patience first
        self.assertEqual(self.sleeps[:4], [10, 20, 40, 60])

    def test_forced_pc_outage_is_a_fault(self):
        self.cat.fail = [RuntimeError("HTTP 504")] * 100
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_SOURCE": "pc"}), mock.patch.object(naip_pc, "_http_json", self.cat), self.usgs_never():
            with self.assertRaisesRegex(BakeFault, "Planetary Computer"):
                naip.covered(FRAME, AREA)
        self.assertEqual(len(self.sleeps), naip_pc.TRIES - 1)  # full patience: nothing behind it

    def test_an_empty_search_with_a_full_control_is_sentinel(self):
        self.cat.features = []
        black = mock.Mock(status_code=200, headers={"content-type": "image/jpeg"}, content=_jpeg((0, 0, 0)))
        out = self.dir / "naip.tif"
        with mock.patch.object(naip_pc, "_http_json", self.cat), mock.patch.object(naip, "_get_with_retry", return_value=black), \
                mock.patch.object(naip, "fetch_sentinel2", return_value={"source": "Sentinel-2 L2A (TCI)"}) as s2:
            meta = naip.fetch_naip(FRAME, AREA, out, self.cache)
        s2.assert_called_once()
        self.assertEqual(meta["source"], "Sentinel-2 L2A (TCI)")
        self.assertIn(("POST", f"{naip_pc.STAC}/search"), self.cat.calls)

    def test_an_empty_control_is_not_an_answer(self):
        self.cat.features = []
        self.cat.control = False
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_SOURCE": "pc"}), mock.patch.object(naip_pc, "_http_json", self.cat):
            with self.assertRaisesRegex(BakeFault, "control"):
                naip.covered(FRAME, AREA)

    def test_pc_down_and_usgs_up_serves_from_usgs(self):
        # the reverse fallback: the catalogue answers nothing for minutes, the ImageServer is fine
        from corridor import network_tiles

        self.cat.fail = [RuntimeError("HTTP 503")] * 100
        colourful = mock.Mock(status_code=200, headers={"content-type": "image/jpeg"}, content=_jpeg(None))
        usgs_calls: list = []

        def usgs(url, params, timeout, tries=9, session=None):
            usgs_calls.append(params.get("size"))
            if params.get("size") == "32,32":
                return colourful
            w, h = (int(v) for v in params["size"].split(","))
            return mock.Mock(status_code=200, headers={"content-type": "image/jpeg"}, content=_jpeg(GREEN, (w, h)))

        out = self.dir / "naip_1m.tif"
        with mock.patch.object(naip_pc, "_http_json", self.cat), mock.patch.object(naip, "_get_with_retry", usgs):
            meta = network_tiles.naip_tiled(FRAME, AREA, box(*AREA), out, self.cache, res=0.6)
        self.assertEqual(meta["tiles_by_source"], {"usgs": 1})
        self.assertIn("USGS", meta["source"])
        self.assertEqual(usgs_calls, ["32,32", "1000,1000"])
        with rasterio.open(out) as ds:
            self.assertEqual(ds.res, (0.6, 0.6))

    def test_a_tile_read_that_fails_trips_the_breaker_to_usgs(self):
        def bad_read(*a, **k):
            raise RuntimeError("Planetary Computer read of md_2023: HTTP 503")

        def usgs(url, params, timeout, tries=9, session=None):
            w, h = (int(v) for v in params["size"].split(","))
            return mock.Mock(status_code=200, headers={"content-type": "image/jpeg"}, content=_jpeg(GREEN, (w, h)))

        with mock.patch.object(naip_pc, "_http_json", self.cat), mock.patch.object(naip_pc, "warp_item", bad_read), \
                mock.patch.object(naip, "_get_with_retry", usgs), mock.patch.object(naip, "TILE_PX", 500):
            tiles = [t for _, _, t in naip.plan_tiles(FRAME, AREA, 0.6, self.cache)]
            prov = naip.fetch_tiles(FRAME, tiles, jobs=1)
        self.assertEqual(prov["tiles_by_source"], {"usgs": 4})
        self.assertFalse(any(t.pc.exists() for t in tiles), "a failed read must not publish a cached piece")


class TokenTest(unittest.TestCase):
    def test_the_token_is_reused_then_refreshed_near_expiry(self):
        tok = naip_pc.Token()
        now = [1_000_000.0]
        issued: list[str] = []
        import datetime as dt

        # issued for an hour, like the real endpoint's `msft:expiry`
        iso = dt.datetime.fromtimestamp(now[0] + 3600.0, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

        def endpoint(method, url, body=None, timeout=60):
            issued.append(url)
            return {"msft:expiry": iso, "token": f"sig={len(issued)}"}

        with mock.patch.object(naip_pc, "_http_json", endpoint), mock.patch("time.time", lambda: now[0]):
            self.assertEqual(tok.get(), "sig=1")
            now[0] += 1800  # half an hour in: plenty left
            self.assertEqual(tok.get(), "sig=1")
            now[0] += 1300  # 500 s left, inside the 600 s margin
            self.assertEqual(tok.get(), "sig=2")
        self.assertEqual(len(issued), 2)
        self.assertTrue(issued[0].endswith("/token/naip"))

    def test_a_403_forces_a_fresh_token(self):
        item = naip_pc.Item("x", "https://example.invalid/x.tif", "2023-07-01", 2023, "md", 0.6, box(0, 0, 1, 1))
        forced: list[bool] = []
        with mock.patch.object(naip_pc.TOKEN, "get", lambda force=False, tries=9: forced.append(force) or "sig=t"), \
                mock.patch("rasterio.open", side_effect=rasterio.errors.RasterioIOError("HTTP response code: 403 AuthenticationFailed")), \
                mock.patch("time.sleep", lambda s: None):
            with self.assertRaises(RuntimeError):
                naip_pc.warp_item(item, FRAME, 0, 1, 0.6, 2, 2, tries=2)
        self.assertIn(True, forced)
        self.assertEqual(naip_pc.dataset_path("/local/a.tif"), "/local/a.tif")


class HorizonTest(_Base):
    def test_the_horizon_jpeg_comes_from_the_catalogue_at_its_size(self):
        write_cog(self.dir / "h.tif", (354000, 4317000, 356600, 4319600), 0.6, GREEN)
        cat = FakeCatalogue([feature("md_2023", self.dir / "h.tif", (354000, 4317000, 356600, 4319600), 2023, 0.6, "md")])
        out = self.dir / "horizon_naip_60m.jpg"
        bbox = (354300.0, 4317300.0, 356100.0, 4319100.0)  # 1800 m at 60 m = 30 px
        with mock.patch.object(naip_pc, "_http_json", cat), self.usgs_never():
            meta = naip.fetch_horizon_image(FRAME, out, bbox, 30)
        self.assertEqual(meta["source"], "pc")
        im = np.asarray(Image.open(out).convert("RGB"))
        self.assertEqual(im.shape, (30, 30, 3))
        self.assertTrue((np.abs(im.astype(int) - np.array(GREEN)) < 12).all())


def _jpeg(colour, size=(32, 32)) -> bytes:
    if colour is None:
        a = np.random.default_rng(1).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
    else:
        a = np.empty((size[1], size[0], 3), dtype=np.uint8)
        a[:] = colour
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG", quality=95)
    return buf.getvalue()


if __name__ == "__main__":
    unittest.main()
