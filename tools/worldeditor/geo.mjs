// Geometry for defining a world, and the one frame decision this service makes.
//
// THE WORLD EDITOR WORKS IN LON/LAT, END TO END. A drawn boundary, a search result, a road, a site
// definition — all WGS84 degrees. Nothing here is ever site metres, and that is deliberate: site
// metres are meaningless without `manifest.frame.kind` and an anchor, guessing wrong rotates a
// world by the grid convergence (1.06° at Crofton, 55 m at 3 km) and it looks perfectly plausible
// while being wrong. Four lanes lost a day each to exactly that on 2026-09-21. This service never
// holds a coordinate that needs a frame stamp to interpret, so it cannot make that mistake.
//
// The ONE metre quantity that leaves here is `radius_m`, a geodesic distance, which is frame-free.
//
// The bake's authored files (adjustments/placements/structures) ARE site metres. This service
// stores them as opaque bytes and never reads a coordinate out of them — see store.mjs.

/** Great-circle metres between two lon/lat points. Good to ~0.3% — fine for a bake radius. */
export function haversineM(a, b) {
  const toRad = Math.PI / 180
  const p1 = a.lat * toRad
  const p2 = b.lat * toRad
  const dp = p2 - p1
  const dl = (b.lon - a.lon) * toRad
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * A local tangent plane about `origin`, in metres, for doing planar geometry on a few kilometres
 * of lon/lat. NOT the render frame and not stored anywhere — it exists inside one function call
 * and the answer comes back out as lon/lat.
 */
export function localFrame(origin) {
  const k = Math.cos((origin.lat * Math.PI) / 180)
  const mPerDegLat = 111132.92 - 559.82 * Math.cos((2 * origin.lat * Math.PI) / 180)
  const mPerDegLon = 111412.84 * k
  return {
    to: (p) => [(p.lon - origin.lon) * mPerDegLon, (p.lat - origin.lat) * mPerDegLat],
    from: ([x, y]) => ({ lon: origin.lon + x / mPerDegLon, lat: origin.lat + y / mPerDegLat }),
  }
}

/* ---- the smallest circle that contains a drawn boundary --------------------------------------- */

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
const inCircle = (c, p) => dist2(c.c, p) <= c.r2 * (1 + 1e-12)

const circle2 = (a, b) => ({ c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r2: dist2(a, b) / 4 })

function circle3(a, b, c) {
  const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1]
  const d = 2 * (bx * cy - by * cx)
  if (Math.abs(d) < 1e-9) return null // collinear: the two-point circle over the extremes covers it
  const b2 = bx * bx + by * by
  const c2 = cx * cx + cy * cy
  const ux = (cy * b2 - by * c2) / d
  const uy = (bx * c2 - cx * b2) / d
  return { c: [a[0] + ux, a[1] + uy], r2: ux * ux + uy * uy }
}

/**
 * Welzl's minimum enclosing circle, in metres, on points already in a local plane.
 *
 * WHY NOT CENTROID + FURTHEST POINT. The bake takes a centre and a RADIUS, and its cost — every
 * raster, every lidar node, every Overpass response — goes as the area, r². The naive circle about
 * the centroid of an L-shaped or elongated boundary is routinely 1.3–1.6x the true radius, which
 * is 1.7–2.6x the work and the storage for a boundary somebody drew tightly on purpose. The
 * expected-linear randomised algorithm is forty lines and removes the question.
 */
export function minimumEnclosingCircle(points) {
  const pts = points.slice()
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pts[i], pts[j]] = [pts[j], pts[i]]
  }
  let c = null
  for (let i = 0; i < pts.length; i++) {
    if (c && inCircle(c, pts[i])) continue
    c = { c: pts[i].slice(), r2: 0 }
    for (let j = 0; j < i; j++) {
      if (inCircle(c, pts[j])) continue
      c = circle2(pts[i], pts[j])
      for (let k = 0; k < j; k++) {
        if (inCircle(c, pts[k])) continue
        c = circle3(pts[i], pts[j], pts[k]) ?? c
      }
    }
  }
  return c ? { c: c.c, r: Math.sqrt(c.r2) } : { c: [0, 0], r: 0 }
}

/**
 * A drawn boundary → the circle the bake will actually cut, as lon/lat + metres.
 *
 * The bake has no notion of an arbitrary boundary: `sites.json` is a point and a radius, and
 * `network.py` takes every road within it. So what the editor draws is a HINT, and this is where
 * that becomes honest — the UI draws this circle back on the map so what you get is what you see.
 * The polygon is kept on the definition as provenance, never as a clip.
 */
export function circleFor(ring) {
  if (!ring.length) throw new Error('an empty boundary has no circle')
  const origin = {
    lon: ring.reduce((s, p) => s + p.lon, 0) / ring.length,
    lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
  }
  const f = localFrame(origin)
  const mec = minimumEnclosingCircle(ring.map(f.to))
  const centre = f.from(mec.c)
  return { lon: round6(centre.lon), lat: round6(centre.lat), radius_m: Math.round(mec.r) }
}

const round6 = (v) => Math.round(v * 1e6) / 1e6

/** Even-odd, on lon/lat. Used to pick which roads a drawn boundary contains. */
export function pointInRing(ring, p) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) hit = !hit
  }
  return hit
}

/** The bbox a lon/lat ring spans, as Overpass wants it: south,west,north,east. */
export function bboxOf(points, padM = 0) {
  let s = 90, w = 180, n = -90, e = -180
  for (const p of points) {
    s = Math.min(s, p.lat)
    n = Math.max(n, p.lat)
    w = Math.min(w, p.lon)
    e = Math.max(e, p.lon)
  }
  if (padM > 0) {
    const dLat = padM / 111132.0
    const dLon = padM / (111412.84 * Math.max(0.05, Math.cos(((n + s) / 2) * Math.PI / 180)))
    s -= dLat; n += dLat; w -= dLon; e += dLon
  }
  return { south: s, west: w, north: n, east: e }
}

/** Metres of centreline in a set of lon/lat polylines — the honest size of what was selected. */
export function lengthM(lines) {
  let m = 0
  for (const line of lines) for (let i = 1; i < line.length; i++) m += haversineM(line[i - 1], line[i])
  return m
}

/** `Crofton Parkway` → `crofton-parkway`. Slugs address directories, so they are strict. */
export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
