// Douglas–Peucker, on lon/lat degrees.
//
// WHY IT IS HERE AND NOT IN THE BROWSER. The point of simplifying is to make the CACHED artefact
// small: a motorway across Lombardy arrives from Overpass with 10 m vertex spacing, which is
// perfectly useless at a zoom where the whole road is 200 pixels long. Simplifying on the way in
// means the volume holds what the map will draw, and every later reader of that tile gets the
// small version for free. Simplifying in the browser would move the same bytes over the wire
// every time and burn a frame doing it.
//
// The tolerance is in DEGREES and is therefore anisotropic away from the equator — a degree of
// longitude at 45 N is 0.71 of a degree of latitude. That is deliberate and harmless here: the
// error is a fraction of a tolerance that is itself hundreds of metres, and correcting it would
// mean a cos(lat) term per point for no visible difference. Said out loud so nobody has to work
// out later whether it was an oversight.

/** Perpendicular distance from p to the segment a–b, squared, in degrees². */
function segDist2(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  const cx = a[0] + t * dx
  const cy = a[1] + t * dy
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2
}

/**
 * Iterative rather than recursive: a coastline ring from Natural Earth is tens of thousands of
 * points and the recursive form blows the stack on the pathological cases.
 */
export function simplify(points, tolerance) {
  if (points.length < 3 || tolerance <= 0) return points
  const tol2 = tolerance * tolerance
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let worst = 0
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(points[i], points[first], points[last])
      if (d > worst) {
        worst = d
        index = i
      }
    }
    if (index > 0 && worst > tol2) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

/** Simplify every ring/line of a GeoJSON geometry in place, dropping ones that collapse. */
export function simplifyGeometry(geom, tolerance) {
  if (!geom) return geom
  if (geom.type === 'LineString') return { ...geom, coordinates: simplify(geom.coordinates, tolerance) }
  if (geom.type === 'MultiLineString' || geom.type === 'Polygon') {
    const rings = geom.coordinates.map((r) => simplify(r, tolerance)).filter((r) => r.length >= (geom.type === 'Polygon' ? 4 : 2))
    return rings.length ? { ...geom, coordinates: rings } : null
  }
  if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates
      .map((p) => p.map((r) => simplify(r, tolerance)).filter((r) => r.length >= 4))
      .filter((p) => p.length)
    return polys.length ? { ...geom, coordinates: polys } : null
  }
  return geom
}
