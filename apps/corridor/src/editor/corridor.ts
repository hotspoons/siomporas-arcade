// Corridor coordinates: the frame every siting rule is actually written in.
//
// The site frame (x east, y north) is what gets stored; the corridor frame — along-track metre `s`
// and signed lateral offset from the centreline — is what the rules mean. "30 m back from the
// pavement", "face the road", "thin out past 800 m from a junction" are all statements about the
// road, and converting them by hand at each call site is how signs get flipped.
//
// SIGNS, once, because getting one wrong mirrors a whole town:
//   world  X = east, Y = up, Z = south      site (x, y) -> world (x, ·, -y)
//   travel dir is a unit world vector; LEFT OF TRAVEL is (dir.z, 0, -dir.x)
//     check: heading north, dir = (0,0,-1), left = (-1,0,0) = west. Correct.
//   a compass bearing is 0 at north (-Z) and 90 at east (+X): bearing(v) = atan2(v.x, -v.z)
//   and a three.js object whose front is local -Z needs rotation.y = -bearing.
// `manifest.buildings[].lat` uses the same convention (positive = left of travel), so the bake and
// the editor agree without anyone converting.
import * as THREE from 'three'
import type { Site } from '../scene'

export const bearingOf = (v: THREE.Vector3) => (Math.atan2(v.x, -v.z) * 180) / Math.PI
export const normDeg = (d: number) => ((d % 360) + 360) % 360

/**
 * `buildings[].rect.yaw_deg` is NOT a compass bearing. `buildings.py` computes it as
 * `degrees(atan2(dy, dx)) % 180` over the minimum rotated rectangle's long edge — a MATH ANGLE
 * measured counterclockwise from east in the site frame, describing an axis rather than a facing.
 *
 * A placement's `yaw_deg` becomes `rotation.y = -yaw·π/180`, which sends a box's local +X (its
 * long side, since `footprint_m` is [long, short]) to the site-frame direction at math angle
 * `-yaw`. So aligning the long side with the rectangle is `yaw = -rect.yaw_deg`, and the sign is
 * the difference between a town of buildings squared to their plots and a town mirrored about
 * the east axis — which looks plausible right up until you compare it with the air photo.
 */
export const yawForLongAxis = (rectYawDeg: number) => normDeg(-rectYawDeg)

/** Left of travel at a spine station, as a unit world vector. */
export function leftOf(dir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(dir.z, 0, -dir.x).normalize()
}

/**
 * Nearest spine station to a site-frame point, and the point's corridor coordinates.
 *
 * Coarse sweep then a local refine: the spine is a spline with no inverse, and a 20 m sweep over
 * six kilometres is 320 samples — nothing at authoring rates, and too much per building when
 * autogen runs over three hundred of them, which is why `cache` exists.
 */
export interface Station {
  s: number
  lat: number
  pos: THREE.Vector3
  dir: THREE.Vector3
}

export function nearestStation(site: Site, x: number, y: number, coarse = 20): Station {
  const len = site.manifest.spine.length_m
  const wz = -y
  let best = Infinity
  let bs = 0
  for (let s = 0; s <= len; s += coarse) {
    const p = site.spineAt(s).pos
    const d = (p.x - x) ** 2 + (p.z - wz) ** 2
    if (d < best) { best = d; bs = s }
  }
  for (let s = Math.max(0, bs - coarse); s <= Math.min(len, bs + coarse); s += coarse / 8) {
    const p = site.spineAt(s).pos
    const d = (p.x - x) ** 2 + (p.z - wz) ** 2
    if (d < best) { best = d; bs = s }
  }
  const at = site.spineAt(bs)
  const left = leftOf(at.dir)
  return { s: bs, lat: (x - at.pos.x) * left.x + (wz - at.pos.z) * left.z, pos: at.pos, dir: at.dir }
}

/** Compass bearing for something beside the road that should face it. */
export function yawFacingRoad(site: Site, x: number, y: number): number {
  const st = nearestStation(site, x, y)
  const face = leftOf(st.dir).multiplyScalar(-Math.sign(st.lat) || 1)
  return Math.round(normDeg(bearingOf(face)))
}

/** Site-frame point at along-track `s`, `lat` metres left of the centreline. */
export function atCorridor(site: Site, s: number, lat: number): [number, number] {
  const at = site.spineAt(s)
  const left = leftOf(at.dir)
  return [at.pos.x + left.x * lat, -(at.pos.z + left.z * lat)]
}
