"""The NAIP coverage probe answers only when it was answered.

2026-10-10: a four-minute HTTP 504 from USGS's NAIP ImageServer was read by the probe as "no NAIP
here", and a dc-metro shard swapped 0.6 m aerial photography for 10 m Sentinel-2 with nothing
failing. An outage is not an answer: the probe now raises, and the retry helpers ride out a few
minutes of 5xx before they give up.

Plain unittest: the corridor image's CI runs `python -m unittest discover`, with no pytest in it.
"""
from __future__ import annotations

import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from corridor import BakeFault, horizon, naip  # noqa: E402


class _Resp:
    def __init__(self, status=200, content=b"", ctype="image/jpeg", text=""):
        self.status_code = status
        self.content = content
        self.headers = {"content-type": ctype}
        self.text = text


def _jpeg(colourful: bool) -> bytes:
    a = np.random.default_rng(1).integers(0, 255, (32, 32, 3), dtype=np.uint8) if colourful else np.zeros((32, 32, 3), np.uint8)
    buf = io.BytesIO()
    Image.fromarray(a).save(buf, "JPEG")
    return buf.getvalue()


class _Frame:
    epsg = 32618


BBOX = (300000.0, 4300000.0, 301000.0, 4301000.0)


class ProbeTest(unittest.TestCase):
    """The ImageServer's own content probe (CORRIDOR_NAIP_SOURCE=usgs, or auto's fallback)."""

    def setUp(self):
        self._env = mock.patch.dict(os.environ, {"CORRIDOR_NAIP_SOURCE": "usgs"})
        self._env.start()
        self.addCleanup(self._env.stop)

    def test_coloured_image_is_coverage_and_black_is_none(self):
        with mock.patch.object(naip, "_get_with_retry", lambda *a, **k: _Resp(content=_jpeg(True))):
            self.assertIs(naip.covered(_Frame(), BBOX), True)
        with mock.patch.object(naip, "_get_with_retry", lambda *a, **k: _Resp(content=_jpeg(False))):
            self.assertIs(naip.covered(_Frame(), BBOX), False)

    def test_an_outage_is_not_an_answer(self):
        def down(*a, **k):
            raise RuntimeError("https://imagery.nationalmap.gov/...: HTTP 504")

        with mock.patch.object(naip, "_get_with_retry", down):
            with self.assertRaisesRegex(BakeFault, "could not reach"):
                naip.covered(_Frame(), BBOX)

    def test_an_error_document_is_not_an_answer(self):
        with mock.patch.object(naip, "_get_with_retry", lambda *a, **k: _Resp(ctype="application/json", text='{"error":{"code":500}}')):
            with self.assertRaisesRegex(BakeFault, "instead of an image"):
                naip.covered(_Frame(), BBOX)


class OneSourceDownTest(unittest.TestCase):
    """2026-10-10, the hour the ImageServer answered 504: a bake must not die while the same NAIP is
    one STAC search away. Driven at the HTTP layer (every requests.Session), so it runs unchanged
    against the code before the Planetary Computer source existed — and fails there."""

    def test_an_imageserver_outage_is_ridden_out_by_the_catalogue(self):
        from corridor.geo import Frame

        seen: list[str] = []

        def route(self_, method, url, *a, **k):
            seen.append(url)
            r = mock.Mock(headers={"content-type": "application/json"}, text="")
            if "nationalmap.gov" in url:
                r.status_code, r.headers, r.text = 504, {"content-type": "text/html"}, "<html>504 Gateway Time-out</html>"
            elif url.endswith("/search"):
                r.status_code = 200
                r.json.return_value = {"type": "FeatureCollection", "links": [], "features": [{
                    "id": "md_m_3907659_se_18_030_20230712_20231018",
                    "geometry": {"type": "Polygon", "coordinates": [[[-76.69, 38.99], [-76.62, 38.99], [-76.62, 39.07], [-76.69, 39.07], [-76.69, 38.99]]]},
                    "properties": {"datetime": "2023-07-12T16:00:00Z", "naip:year": "2023", "naip:state": "md", "gsd": 0.3},
                    "assets": {"image": {"href": "https://naipeuwest.blob.core.windows.net/naip/x.tif"}},
                }]}
            else:
                r.status_code, r.headers, r.text = 404, {"content-type": "text/plain"}, "not found"
            return r

        frame = Frame(32618, (354269.88, 4318567.75))
        with mock.patch.dict(os.environ, {"CORRIDOR_NAIP_SOURCE": "auto"}), mock.patch("requests.sessions.Session.request", route), \
                mock.patch("time.sleep", lambda s: None):
            self.assertIs(naip.covered(frame, (354000.0, 4318000.0, 355000.0, 4319000.0)), True)
        self.assertTrue(any("planetarycomputer" in u for u in seen))


class RetryTest(unittest.TestCase):
    def test_retries_ride_out_a_few_minutes_of_5xx(self):
        for mod in (naip, horizon):
            with self.subTest(mod=mod.__name__):
                slept: list[float] = []
                answers = iter([_Resp(504)] * 6 + [_Resp(200, content=b"ok")])
                session = mock.Mock()
                session.get.side_effect = lambda *a, **k: next(answers)
                with mock.patch("time.sleep", lambda s: slept.append(s)), mock.patch.object(mod, "session", session):
                    r = mod._get_with_retry("http://x", {}, timeout=1)
                self.assertEqual(r.status_code, 200)
                # 10, 20, 40, 60, 60, 60 s: an outage of nearly four minutes passes without failing the bake
                self.assertEqual(slept, [10, 20, 40, 60, 60, 60])

    def test_retries_give_up_loudly(self):
        for mod in (naip, horizon):
            with self.subTest(mod=mod.__name__):
                session = mock.Mock()
                session.get.return_value = _Resp(504)
                with mock.patch("time.sleep", lambda s: None), mock.patch.object(mod, "session", session):
                    with self.assertRaisesRegex(RuntimeError, "HTTP 504"):
                        mod._get_with_retry("http://x", {}, timeout=1)


if __name__ == "__main__":
    unittest.main()
