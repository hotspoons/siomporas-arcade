"""The NAIP coverage probe answers only when it was answered.

2026-10-10: a four-minute HTTP 504 from USGS's NAIP ImageServer was read by the probe as "no NAIP
here", and a dc-metro shard swapped 0.6 m aerial photography for 10 m Sentinel-2 with nothing
failing. An outage is not an answer: the probe now raises, and the retry helpers ride out a few
minutes of 5xx before they give up.
"""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from corridor import BakeFault, horizon, naip


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


def test_coloured_image_is_coverage_and_black_is_none(monkeypatch):
    monkeypatch.setattr(naip, "_get_with_retry", lambda *a, **k: _Resp(content=_jpeg(True)))
    assert naip.covered(_Frame(), BBOX) is True
    monkeypatch.setattr(naip, "_get_with_retry", lambda *a, **k: _Resp(content=_jpeg(False)))
    assert naip.covered(_Frame(), BBOX) is False


def test_an_outage_is_not_an_answer(monkeypatch):
    def down(*a, **k):
        raise RuntimeError("https://imagery.nationalmap.gov/...: HTTP 504")

    monkeypatch.setattr(naip, "_get_with_retry", down)
    with pytest.raises(BakeFault, match="could not reach"):
        naip.covered(_Frame(), BBOX)


def test_an_error_document_is_not_an_answer(monkeypatch):
    monkeypatch.setattr(naip, "_get_with_retry", lambda *a, **k: _Resp(ctype="application/json", text='{"error":{"code":500}}'))
    with pytest.raises(BakeFault, match="instead of an image"):
        naip.covered(_Frame(), BBOX)


@pytest.mark.parametrize("mod", [naip, horizon])
def test_retries_ride_out_a_few_minutes_of_5xx(monkeypatch, mod):
    slept: list[float] = []
    monkeypatch.setattr("time.sleep", lambda s: slept.append(s))
    answers = iter([_Resp(504)] * 6 + [_Resp(200, content=b"ok")])

    class S:
        def get(self, *a, **k):
            return next(answers)

    monkeypatch.setattr(mod, "session", S())
    r = mod._get_with_retry("http://x", {}, timeout=1)
    assert r.status_code == 200
    # 10, 20, 40, 60, 60, 60 s: an outage of nearly four minutes passes without failing the bake
    assert slept == [10, 20, 40, 60, 60, 60]


@pytest.mark.parametrize("mod", [naip, horizon])
def test_retries_give_up_loudly(monkeypatch, mod):
    monkeypatch.setattr("time.sleep", lambda s: None)

    class S:
        def get(self, *a, **k):
            return _Resp(504)

    monkeypatch.setattr(mod, "session", S())
    with pytest.raises(RuntimeError, match="HTTP 504"):
        mod._get_with_retry("http://x", {}, timeout=1)
