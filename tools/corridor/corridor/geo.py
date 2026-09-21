"""Coordinate frames for one corridor.

Everything a site produces is in ONE metric frame: the UTM zone of the photo (Maryland is zone 18,
EPSG:32618; Hancock at 78.3W is still zone 18). Lidar arrives in Web Mercator (EPSG:3857 — that is
how USGS stages Entwine), OSM and the photos in WGS84, NAIP in whatever we ask for. All of it is
re-projected here, once, so the game side never sees a degree or a Mercator metre.

Why UTM and not a local ENU frame: gaussworks (Rich's splat pipeline) aligns its worlds to ENU, and
a UTM tile is trivially re-based to ENU by subtracting an origin — the reverse is not true of a
frame that has already been rotated. `Frame.origin` records the origin to subtract.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from pyproj import Transformer

WGS84 = "EPSG:4326"
MERC = "EPSG:3857"


def utm_epsg(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


@dataclass
class Frame:
    epsg: int
    origin: tuple[float, float]  # UTM easting/northing of the site's photo point

    @classmethod
    def at(cls, lon: float, lat: float) -> "Frame":
        epsg = utm_epsg(lon, lat)
        f = cls(epsg, (0.0, 0.0))
        x, y = f.from_wgs(lon, lat)
        f.origin = (float(x), float(y))
        return f

    @property
    def crs(self) -> str:
        return f"EPSG:{self.epsg}"

    # pyproj Transformers are expensive to build and cheap to call; cache per frame.
    def _tr(self, src: str, dst: str) -> Transformer:
        cache = self.__dict__.setdefault("_cache", {})
        key = (src, dst)
        if key not in cache:
            cache[key] = Transformer.from_crs(src, dst, always_xy=True)
        return cache[key]

    def from_wgs(self, lon, lat):
        return self._tr(WGS84, self.crs).transform(lon, lat)

    def to_wgs(self, x, y):
        return self._tr(self.crs, WGS84).transform(x, y)

    def from_merc(self, x, y):
        return self._tr(MERC, self.crs).transform(x, y)

    def to_merc(self, x, y):
        return self._tr(self.crs, MERC).transform(x, y)

    def bbox_wgs(self, xmin: float, ymin: float, xmax: float, ymax: float) -> tuple[float, float, float, float]:
        """WGS84 bbox that contains the UTM bbox (edges sampled — UTM edges curve)."""
        xs = np.linspace(xmin, xmax, 9)
        ys = np.linspace(ymin, ymax, 9)
        px = np.concatenate([xs, xs, np.full(9, xmin), np.full(9, xmax)])
        py = np.concatenate([np.full(9, ymin), np.full(9, ymax), ys, ys])
        lon, lat = self.to_wgs(px, py)
        return float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())

    def bbox_merc(self, xmin: float, ymin: float, xmax: float, ymax: float) -> tuple[float, float, float, float]:
        xs = np.linspace(xmin, xmax, 9)
        ys = np.linspace(ymin, ymax, 9)
        px = np.concatenate([xs, xs, np.full(9, xmin), np.full(9, xmax)])
        py = np.concatenate([np.full(9, ymin), np.full(9, ymax), ys, ys])
        mx, my = self.to_merc(px, py)
        return float(mx.min()), float(my.min()), float(mx.max()), float(my.max())


def snap_bbox(b: tuple[float, float, float, float], step: float = 10.0) -> tuple[float, float, float, float]:
    """Outward-rounded bbox so rasters from different sources land on the same 1 m lattice."""
    import math

    return (
        math.floor(b[0] / step) * step,
        math.floor(b[1] / step) * step,
        math.ceil(b[2] / step) * step,
        math.ceil(b[3] / step) * step,
    )
