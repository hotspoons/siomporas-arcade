"""Coordinate frames for one corridor.

Everything a site produces is in ONE metric frame: the UTM zone of the photo. Lidar arrives in Web
Mercator (EPSG:3857 — that is how USGS stages Entwine), OSM and the photos in WGS84, NAIP in
whatever we ask for. All of it is re-projected here, once, so the game side never sees a degree or
a Mercator metre.

That "one frame" is per SITE, not global, and the baked sites already span four zones: 32618 for
most of Maryland, but 32617 for sideling-i68 (Hancock is at 78.30W and zone 18 starts at 78W),
32619 for acadia-ocean-dr and 32610 for the three California/Oregon sites. Two sites in different
zones have no common metre frame at all, and even inside one zone UTM north is not true north —
1.06 deg at Crofton, and the convergence differs from site to site (see `enu_fit`).

So UTM is where the data is STORED, and WGS84 geodetic is what it MEANS. The render frame is a
true ENU tangent plane about a declared geodetic anchor, which is also what gaussworks (Rich's
splat pipeline) aligns to. `manifest_frame` below emits everything the viewer needs to get there.
See docs/corridor/FRAME.md and packages/engine/src/geo/wgs84.ts.
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

    # --- the geodetic frame ------------------------------------------------------------------
    #
    # UTM is a plane. It has no curvature, its north is not true north, and it has a scale factor.
    # The authoritative frame is WGS84 geodetic and the render frame is a true ENU tangent plane
    # about a geodetic anchor -- see docs/corridor/FRAME.md and packages/engine/src/geo/wgs84.ts.
    #
    # These give the viewer everything it needs to place this site on the ellipsoid WITHOUT a
    # projection library in the browser: where the origin is in lon/lat, and the rigid
    # rotation+scale that takes the stored UTM metres to true ENU metres.

    @property
    def anchor(self) -> tuple[float, float]:
        """The frame origin as WGS84 lon/lat — the geodetic anchor of the site's ENU frame."""
        lon, lat = self.to_wgs(*self.origin)
        return float(lon), float(lat)

    def enu_fit(self, span: float = 25_000.0) -> tuple[float, float]:
        """
        The rigid (rotation, scale) taking stored UTM metres to true ENU metres about the anchor.

        Grid convergence and point scale have closed forms, but fitting them over the site's actual
        extent also absorbs their variation across it, and it is the quantity the viewer will
        apply. Measured residual at crofton-triangle: under 0.34 m at 25 km, so a rigid fit is not
        the limiting error -- curvature is, and the viewer gets that from the ellipsoid itself.

        Returns (convergence_deg, scale) where convergence is UTM north relative to TRUE north,
        positive counter-clockwise.
        """
        import math

        ox, oy = self.origin
        alon, alat = self.anchor
        la = math.radians(alat)
        # ENU basis rows in ECEF, at the anchor
        a_ax, f = 6378137.0, 1 / 298.257223563
        e2 = f * (2 - f)
        def ecef(lon_d, lat_d):
            lo, lt = math.radians(lon_d), math.radians(lat_d)
            n = a_ax / math.sqrt(1 - e2 * math.sin(lt) ** 2)
            return (n * math.cos(lt) * math.cos(lo), n * math.cos(lt) * math.sin(lo), n * (1 - e2) * math.sin(lt))
        a0 = ecef(alon, alat)
        slo, clo, sla, cla = math.sin(math.radians(alon)), math.cos(math.radians(alon)), math.sin(la), math.cos(la)
        east = (-slo, clo, 0.0)
        north = (-sla * clo, -sla * slo, cla)

        sxx = sxy = snn = 0.0
        pts = [(d, 0.0) for d in (-span, -span / 2, span / 2, span)] + [(0.0, d) for d in (-span, -span / 2, span / 2, span)]
        for de, dn in pts:
            lon, lat = self.to_wgs(ox + de, oy + dn)
            p = ecef(float(lon), float(lat))
            d = (p[0] - a0[0], p[1] - a0[1], p[2] - a0[2])
            e = east[0] * d[0] + east[1] * d[1] + east[2] * d[2]
            n = north[0] * d[0] + north[1] * d[1] + north[2] * d[2]
            sxx += de * e + dn * n
            sxy += de * n - dn * e
            snn += de * de + dn * dn
        theta = math.degrees(math.atan2(sxy, sxx))
        scale = math.hypot(sxx, sxy) / snn
        return theta, scale

    def anchor_frame(self) -> "Anchor":
        """This site's ENU tangent frame, anchored at the photo point."""
        if "_anchor_obj" not in self.__dict__:
            lon, lat = self.anchor
            self.__dict__["_anchor_obj"] = Anchor(lon, lat, 0.0)
        return self.__dict__["_anchor_obj"]

    def to_enu(self, x, y):
        """
        UTM easting/northing -> true ENU metres about the site anchor.

        THE choke point. Everything the bake writes as "site metres" goes through here, so the
        stored world is a tangent plane on the ellipsoid rather than a UTM plane. Accepts scalars
        or numpy arrays; returns (east, north).
        """
        lon, lat = self.to_wgs(x, y)
        e, n, _ = self.anchor_frame().to_local(lon, lat, 0.0)
        return e, n

    def control_lattice(self, bbox: tuple[float, float, float, float], n: int = 9) -> dict:
        """
        A geodetic control lattice over a raster's UTM bbox, for the viewer to interpolate.

        A raster is a regular grid on the UTM PLANE; in true ENU that grid is rotated, scaled and
        curved, so its bbox cannot simply be relabelled and resampling it would be lossy and slow.
        Instead the viewer bilinearly interpolates lon/lat from this lattice and puts each vertex
        where the ellipsoid says. Measured over crofton-triangle's 8.56 x 7.90 km DEM, worst error
        against the exact projection: 1179 mm at 2x2, 295 at 3x3, 73 at 5x5, **18 at 9x9**, 4.6 at
        17x17 -- clean quadratic convergence, as bilinear should be. 9x9 is 81 points, about 1.3 kB
        of JSON, against 100 mm lane markings.

        It also means the browser needs no projection library and never learns what CRS the bake
        used, so a future source in some other projection just emits its own lattice.
        """
        xs = np.linspace(bbox[0], bbox[2], n)
        ys = np.linspace(bbox[1], bbox[3], n)
        gx, gy = np.meshgrid(xs, ys)
        lon, lat = self.to_wgs(gx.ravel(), gy.ravel())
        # rows run SOUTH to NORTH, columns WEST to EAST, matching the bbox order
        return {
            "n": n,
            "lon": [round(float(v), 9) for v in np.asarray(lon)],
            "lat": [round(float(v), 9) for v in np.asarray(lat)],
        }

    def manifest_frame(self) -> dict:
        """The `frame` block a site writes: the UTM it is stored in, and the geodetic it means."""
        alon, alat = self.anchor
        conv, scale = self.enu_fit()
        return {
            "epsg": self.epsg,
            "origin": [self.origin[0], self.origin[1]],
            # everything below is the geodetic frame; `kind` lets the viewer refuse a site it
            # cannot place rather than silently drawing it on a plane
            "kind": "utm-enu",
            "anchor": {"lon": round(alon, 9), "lat": round(alat, 9), "h": 0.0},
            "utm_convergence_deg": round(conv, 7),
            "utm_scale": round(scale, 10),
        }

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


class Anchor:
    """
    A local ENU tangent frame about a geodetic anchor — the Python mirror of
    packages/engine/src/geo/wgs84.ts `Anchor`.

    The two are checked against each other (probes/corridor-frame.mjs) because the bake converts
    the vector geometry and the viewer converts the rasters, and if they disagree the roads will
    not sit on the ground. Same constants, same axis conventions:

        ECEF   X through (0E, 0N), Y through (90E, 0N), Z through the north pole
        ENU    east, north, up at the anchor
    """

    A = 6378137.0
    F = 1 / 298.257223563
    B = A * (1 - F)
    E2 = F * (2 - F)

    def __init__(self, lon: float, lat: float, h: float = 0.0):
        import math

        self.lon, self.lat, self.h = float(lon), float(lat), float(h)
        self.ecef = self._to_ecef(lon, lat, h)
        lo, la = math.radians(lon), math.radians(lat)
        slo, clo, sla, cla = math.sin(lo), math.cos(lo), math.sin(la), math.cos(la)
        self.east = (-slo, clo, 0.0)
        self.north = (-sla * clo, -sla * slo, cla)
        self.up = (cla * clo, cla * slo, sla)

    @classmethod
    def _to_ecef(cls, lon, lat, h):
        import math

        lo, la = math.radians(lon), math.radians(lat)
        sla = math.sin(la)
        n = cls.A / math.sqrt(1 - cls.E2 * sla * sla)
        return ((n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo), (n * (1 - cls.E2) + h) * sla)

    def to_local(self, lon, lat, h=0.0):
        """geodetic -> local ENU metres. Vectorised: lon/lat/h may be numpy arrays."""
        lo = np.radians(np.asarray(lon, dtype=float))
        la = np.radians(np.asarray(lat, dtype=float))
        sla, cla = np.sin(la), np.cos(la)
        n = self.A / np.sqrt(1 - self.E2 * sla * sla)
        hh = np.asarray(h, dtype=float)
        px = (n + hh) * cla * np.cos(lo)
        py = (n + hh) * cla * np.sin(lo)
        pz = (n * (1 - self.E2) + hh) * sla
        dx, dy, dz = px - self.ecef[0], py - self.ecef[1], pz - self.ecef[2]
        e = self.east[0] * dx + self.east[1] * dy + self.east[2] * dz
        nn = self.north[0] * dx + self.north[1] * dy + self.north[2] * dz
        u = self.up[0] * dx + self.up[1] * dy + self.up[2] * dz
        return e, nn, u


def snap_bbox(b: tuple[float, float, float, float], step: float = 10.0) -> tuple[float, float, float, float]:
    """Outward-rounded bbox so rasters from different sources land on the same 1 m lattice."""
    import math

    return (
        math.floor(b[0] / step) * step,
        math.floor(b[1] / step) * step,
        math.ceil(b[2] / step) * step,
        math.ceil(b[3] / step) * step,
    )
