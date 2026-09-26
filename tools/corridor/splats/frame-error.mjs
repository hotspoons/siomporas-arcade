// The design's claim: two ENU frames 3 km apart are not related by a translation, and composing
// through ECEF fixes it. Measured with the engine's own pyproj-checked helpers.
import { geodeticToEcef, ecefToGeodetic, enuBasis } from '/workspaces/apex-conduit/packages/engine/src/geo/wgs84.ts'
const site = { lon: -76.69057, lat: 38.98138, h: 0 }          // arrowhead-farms' anchor
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const toEnu = (anchor, p) => { const B = enuBasis(anchor.lon, anchor.lat); const o = geodeticToEcef(anchor.lon, anchor.lat, anchor.h); const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]; return [dot(d, B.east), dot(d, B.north), dot(d, B.up)] }
const fromEnu = (anchor, e) => { const B = enuBasis(anchor.lon, anchor.lat); const o = geodeticToEcef(anchor.lon, anchor.lat, anchor.h); return [o[0] + B.east[0] * e[0] + B.north[0] * e[1] + B.up[0] * e[2], o[1] + B.east[1] * e[0] + B.north[1] * e[1] + B.up[1] * e[2], o[2] + B.east[2] * e[0] + B.north[2] * e[1] + B.up[2] * e[2]] }
for (const km of [0.5, 1, 3, 6]) {
  // a capture anchored km east + km north of the site anchor
  const gEcef = fromEnu(site, [km * 1000, km * 1000, 0])
  const g = ecefToGeodetic(gEcef[0], gEcef[1], gEcef[2])
  const gauss = { lon: g.lon, lat: g.lat, h: g.h }
  let worst = 0, worstAt = null
  for (const p of [[0,0,0],[1000,0,0],[0,1000,0],[1000,1000,0],[2000,500,0],[-1000,1000,0]]) {
    const exact = toEnu(site, fromEnu(gauss, p))                       // through ECEF
    const naive = [p[0] + km * 1000, p[1] + km * 1000, p[2]]           // "just a translation"
    const err = Math.hypot(exact[0] - naive[0], exact[1] - naive[1], exact[2] - naive[2])
    if (err > worst) { worst = err; worstAt = p }
  }
  console.log(`anchor ${km} km away: worst error of treating it as a translation = ${worst.toFixed(2)} m (at ENU ${worstAt})`)
}
