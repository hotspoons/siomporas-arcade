// WGS84 → this site's metres: the projectors the minimap, the scene and the search share.
//
// Pure math, no DOM, so the minimap's worker (minimap.worker.ts) can import it as well as the main
// thread — they used to live in minimap.ts, which imports the interface kit and cannot load in a
// worker. minimap.ts re-exports them, so every existing import keeps working.

/**
 * WGS84 → local east/north metres about the site anchor (the `enu` frame), through ECEF.
 *
 * Exact, not a rotation of the UTM grid: verified against the baked spines at 0.6-0.7 m mean,
 * which is OSM's own digitising accuracy.
 */
export function enuProjector(lon0: number, lat0: number, h0: number): (lon: number, lat: number) => [number, number] {
  const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F)
  const D = Math.PI / 180
  const ecef = (lon: number, lat: number, h: number): [number, number, number] => {
    const lo = lon * D, la = lat * D
    const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2)
    return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)]
  }
  const [x0, y0, z0] = ecef(lon0, lat0, h0)
  const lo0 = lon0 * D, la0 = lat0 * D
  const sLo = Math.sin(lo0), cLo = Math.cos(lo0), sLa = Math.sin(la0), cLa = Math.cos(la0)
  return (lon, lat) => {
    const [x, y, z] = ecef(lon, lat, 0)
    const dx = x - x0, dy = y - y0, dz = z - z0
    return [-sLo * dx + cLo * dy, -sLa * cLo * dx - sLa * sLo * dy + cLa * dz]
  }
}

/**
 * WGS84 → site frame (UTM easting/northing minus the origin). A compact transverse-Mercator
 * forward formula (Krüger series, good to mm), because osm.geojson is the only layer the viewer
 * reads that is not already in metres.
 */
export function utmProjector(epsg: number, ox: number, oy: number): (lon: number, lat: number) => [number, number] {
  const zone = epsg % 100
  const south = Math.floor(epsg / 100) === 327
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180)
  const a = 6378137, f = 1 / 298.257223563
  const n = f / (2 - f), A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64)
  const alpha = [n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3, (13 / 48) * n ** 2 - (3 / 5) * n ** 3, (61 / 240) * n ** 3]
  const k0 = 0.9996, E0 = 500000, N0 = south ? 10000000 : 0
  return (lon, lat) => {
    const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180 - lon0
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - ((2 * Math.sqrt(n)) / (1 + n)) * Math.atanh(((2 * Math.sqrt(n)) / (1 + n)) * Math.sin(phi)))
    const xi = Math.atan(t / Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t))
    let E = eta, N = xi
    for (let j = 1; j <= 3; j++) {
      E += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
      N += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    }
    return [E0 + k0 * A * E - ox, N0 + k0 * A * N - oy]
  }
}

/** WGS84 → this site's metres, whichever frame the manifest holds — see the note in `load()`. */
export function siteProjector(frame: { epsg: number; origin: [number, number]; kind?: string; anchor?: { lon: number; lat: number; h?: number } }): (lon: number, lat: number) => [number, number] {
  return frame.kind === 'enu' && frame.anchor ? enuProjector(frame.anchor.lon, frame.anchor.lat, frame.anchor.h ?? 0) : utmProjector(frame.epsg, frame.origin[0], frame.origin[1])
}
