// The things beside the road: traffic signals, stop and give-way signs.
//
// A road is furnished and ours was bare. All of this is already in the bake — Crofton has 218
// `highway=traffic_signals` nodes and 51 stop/give-way nodes — and none of it was drawn, which is
// most of why a signalised suburban junction read as a crossroads in a field.
//
// SIGNALS are mast-arm signals, the American kind: a pole on the near right of the approach with
// an arm out over the carriageway and a head per lane hanging off it. The bake works out which way
// the traffic runs (export.py `_signals`) and hands over a compass bearing the heads should face;
// this module works out where the pole actually stands, which the bake cannot, because only the
// viewer knows where the pavement ends. The node sits on the centreline, so the pole is walked
// sideways along the right of travel until `edgeDistance` says it is clear of the asphalt.
//
// The heads are DARK. There is no controller — nothing in the bake or the viewer knows what phase
// a junction is in — and a signal cycling to a timer that has no relationship to the junction is
// worse than an unlit one, because it invites you to obey it. Red/amber/green lenses are there,
// unlit, and `FURNITURE_SIGNAL_LIT` turns one on for a look at the colours. When someone writes a
// controller it drives that uniform.
//
// INSTANCED, bucketed by lane count. A mast arm's length is its road's width, so it cannot be an
// instance transform without stretching the heads with it; one merged geometry per lane count and
// one InstancedMesh each is seven draw calls for Crofton's 205 masts instead of 205.
//
// The geometry faces −Z, because the repo renders a placement bearing as `rotation.y =
// -(yaw_deg · π / 180)` (placements.ts), and under that a model's −Z is what ends up pointing
// along the bearing.
import * as THREE from 'three'
import type { Manifest } from './site'
import * as T from './tuning'

const toWorld = (x: number, y: number) => new THREE.Vector3(x, 0, -y)

export interface FurnitureResult {
  group: THREE.Group
  counts: { masts: number; signs: number; movedOffPavement: number; stillOnPavement: number; onTheLeft: number; noRoadNearby: number; armNoRoad: number }
}

/** Merge a list of geometries, keeping position, normal and colour. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = []
  const nor: number[] = []
  const col: number[] = []
  const idx: number[] = []
  for (const g of list) {
    const gi = g.index
    const gp = g.getAttribute('position') as THREE.BufferAttribute
    const gn = g.getAttribute('normal') as THREE.BufferAttribute
    const gc = g.getAttribute('color') as THREE.BufferAttribute | undefined
    const base = pos.length / 3
    for (let i = 0; i < gp.count; i++) {
      pos.push(gp.getX(i), gp.getY(i), gp.getZ(i))
      nor.push(gn.getX(i), gn.getY(i), gn.getZ(i))
      if (gc) col.push(gc.getX(i), gc.getY(i), gc.getZ(i))
      else col.push(1, 1, 1)
    }
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i))
    else for (let i = 0; i < gp.count; i++) idx.push(base + i)
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  out.setIndex(idx)
  return out
}

/** Paint every vertex of a geometry one colour, so a merge can carry many colours in one mesh. */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex)
  const n = g.getAttribute('position').count
  const arr = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

/**
 * One signal head: a dark housing with three lenses on its −Z face.
 *
 * The lenses are flat discs rather than spheres on purpose. A head is 0.3 m of plastic seen from
 * fifty metres; what the eye reads is three circles in a row on a dark rectangle, and a sphere
 * costs twelve times the triangles to say the same thing.
 */
function headGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const housing = new THREE.BoxGeometry(0.36, 1.0, 0.3)
  parts.push(tint(housing, 0x23282c))
  const visor = new THREE.BoxGeometry(0.4, 0.06, 0.12)
  visor.translate(0, 0.52, -0.12)
  parts.push(tint(visor, 0x1a1e21))
  const LENS = [
    { y: 0.3, hex: 0x5a1a16 }, // unlit red: the colour a dark lens actually is, not a bright one
    { y: 0.0, hex: 0x5c4a16 },
    { y: -0.3, hex: 0x16401f },
  ]
  for (const l of LENS) {
    const lens = new THREE.CircleGeometry(0.12, 12)
    lens.rotateY(Math.PI) // face −Z
    lens.translate(0, l.y, -0.152)
    parts.push(tint(lens, l.hex))
  }
  return merge(parts)
}

/**
 * A whole mast for a road of `lanes` lanes, standing at the kerb with the arm reaching out over
 * the carriageway and the heads looking down it in −Z.
 *
 * `side` is +1 when the pole ended up on the right of travel, which is where an American mast arm
 * belongs and where `toKerb` tries first, and −1 when the only clear ground was on the left. The
 * arm has to reach toward the ROAD either way, so the geometry is mirrored rather than the
 * instance: a negative scale on an instance flips its winding and lights it inside out.
 */
function mastGeometry(lanes: number, arm: number, side: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const H = T.FURNITURE_SIGNAL_HEIGHT
  const pole = new THREE.CylinderGeometry(0.11, 0.15, H, 8)
  pole.translate(0, H / 2, 0)
  parts.push(tint(pole, 0x4c5358))
  const base = new THREE.CylinderGeometry(0.26, 0.3, 0.35, 8)
  base.translate(0, 0.17, 0)
  parts.push(tint(base, 0x9a9a95))
  // the arm: a shallow taper out over the road, with a brace back to the pole
  const armGeo = new THREE.CylinderGeometry(0.06, 0.1, arm, 6)
  armGeo.rotateZ(-Math.PI / 2)
  armGeo.translate((side * arm) / 2, H - 0.25, 0)
  parts.push(tint(armGeo, 0x4c5358))
  const brace = new THREE.CylinderGeometry(0.04, 0.04, Math.hypot(arm * 0.55, 1.3), 5)
  brace.rotateZ(-side * Math.atan2(arm * 0.55, 1.3))
  brace.translate(side * arm * 0.27, H - 0.9, 0)
  parts.push(tint(brace, 0x4c5358))
  // a head per lane, hung under the arm and spread across it
  const head = headGeometry()
  const n = Math.max(1, Math.min(lanes, 6))
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.62 : 0.3 + (0.66 * i) / (n - 1)
    const h = head.clone()
    h.translate(side * arm * t, H - 0.9, 0)
    parts.push(h)
  }
  head.dispose()
  return merge(parts)
}

/** A sign on a post: an octagon for stop, a down triangle for give way. */
function signGeometry(kind: 'stop' | 'give_way'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const H = T.FURNITURE_SIGN_HEIGHT
  const post = new THREE.CylinderGeometry(0.035, 0.035, H, 5)
  post.translate(0, H / 2, 0)
  parts.push(tint(post, 0x6e6e68))
  const face =
    kind === 'stop'
      ? new THREE.CircleGeometry(0.38, 8)
      : new THREE.CircleGeometry(0.45, 3)
  if (kind === 'give_way') face.rotateZ(Math.PI) // point down
  face.rotateY(Math.PI) // face −Z
  face.translate(0, H - 0.05, -0.04)
  parts.push(tint(face, kind === 'stop' ? 0xa8231f : 0xd8d8d2))
  // the back, so it is not a hole when you drive past it
  const back = face.clone()
  back.rotateY(Math.PI)
  back.translate(0, 0, 0.08)
  parts.push(tint(back, 0x8e8e88))
  return merge(parts)
}

/**
 * Build every piece of furniture this site has.
 *
 * `edgeDistance` is what keeps a mast out of the carriageway: the OSM node is on the centreline,
 * so the pole is stepped sideways along the right of travel until it is clear of the asphalt, up
 * to a limit. Where a site has no pavement data the step still happens and simply lands at the
 * nominal offset.
 */
export function buildFurniture(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): FurnitureResult {
  const group = new THREE.Group()
  group.name = 'furniture'
  const counts = { masts: 0, signs: 0, movedOffPavement: 0, stillOnPavement: 0, onTheLeft: 0, noRoadNearby: 0, armNoRoad: 0 }
  const data = manifest.signals
  if (!data) return { group, counts }

  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.25 })

  /**
   * Walk a post sideways off the carriageway.
   *
   * The OSM node is on the road centreline, so every one of these starts in a traffic lane. The
   * post belongs on the RIGHT of travel, which is where an American mast arm stands, so the right
   * is tried first — but at a big signalised junction the right-hand walk can cross the other
   * road and stay on asphalt the whole way, and a fixed one-sided walk left 41 of Crofton's 205
   * masts standing in a lane, one of them 15.7 m inside it. So: try both sides, take the nearer
   * clear spot, prefer the right where both work, and if neither clears within the limit take
   * whichever got furthest out rather than the last step of a failed walk.
   */
  const toKerb = (p: THREE.Vector3, side: THREE.Vector3, back: THREE.Vector3): { p: THREE.Vector3; moved: boolean; clear: boolean; sign: number } => {
    const want = T.FURNITURE_KERB_CLEAR
    if (edgeDistance(p.x, p.z) >= want) return { p, moved: false, clear: true, sign: 1 }
    const step = 0.5
    let bestE = -Infinity
    let bestSign = 1
    const best = p.clone()
    const q = new THREE.Vector3()
    const from = new THREE.Vector3()
    // Two axes, searched nearest-first: BACK along the approach, away from the junction, and then
    // sideways to the kerb. The setback is not padding — a mast belongs at the stop line, and the
    // OSM node sits in the middle of the junction box, where at a big crossing there is no clear
    // ground within any sideways distance because the cross street's asphalt is there too. Walking
    // out of the box first is both where the thing really stands and the only way to find a kerb.
    for (let b = 0; b <= T.FURNITURE_SETBACK_MAX; b += 2) {
      from.set(p.x + back.x * b, 0, p.z + back.z * b)
      if (b > 0 && edgeDistance(from.x, from.z) >= want) return { p: from.clone(), moved: true, clear: true, sign: 1 }
      for (let d = step; d <= T.FURNITURE_KERB_MAX; d += step) {
        for (const sgn of [1, -1]) {
          q.set(from.x + side.x * d * sgn, 0, from.z + side.z * d * sgn)
          const e = edgeDistance(q.x, q.z)
          // the first clearance found wins, and the right-hand side is tried first at each step
          if (e >= want) return { p: q.clone(), moved: true, clear: true, sign: sgn }
          if (e > bestE) {
            bestE = e
            bestSign = sgn
            best.copy(q)
          }
        }
      }
    }
    return { p: best, moved: true, clear: false, sign: bestSign }
  }

  // --- signal masts, bucketed by lane count so the arm length can be real ----------------------
  const byLanes = new Map<number, { arm: number; side: number; at: { pos: THREE.Vector3; yaw: number; src: unknown }[] }>()
  /**
   * A signal only belongs to a road we DRAW.
   *
   * The bake reads the whole OSM extract, and Crofton's has 10 593 drivable ways while the viewer
   * draws 18 of them. Measured at the raw nodes: 75 of the 205 masts are on drawn pavement, 37 are
   * within 20 m of it, and 93 are more than 20 m away — signals for roads that are not there,
   * which would stand in fields with their arms over grass. So anything further than
   * FURNITURE_MAX_FROM_ROAD from a carriageway edge is not placed. When more of the network gets
   * drawn they come back on their own, because the test is against what is drawn, not a list.
   */
  const nearARoad = (p: THREE.Vector3) => edgeDistance(p.x, p.z) <= T.FURNITURE_MAX_FROM_ROAD

  for (const m of data.masts ?? []) {
    const lanes = Math.max(1, Math.min(6, Math.round(m.lanes || 2)))
    const arm = Math.max(2.5, (m.arm_m || 4.7) * T.FURNITURE_SIGNAL_ARM_SCALE)
    // the heads face `yaw_deg`; traffic travels the other way; right of travel is where the pole
    // stands. In the site frame a bearing B is (sin B, cos B); world is (x, −y).
    const b = (m.yaw_deg * Math.PI) / 180
    const headDir = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b))
    const travel = headDir.clone().negate()
    const right = new THREE.Vector3(-travel.z, 0, travel.x) // travel × up
    const p0 = toWorld(m.x, m.y)
    if (!nearARoad(p0)) {
      counts.noRoadNearby++
      continue
    }
    const { p, moved, clear, sign } = toKerb(p0, right, headDir)
    if (moved) counts.movedOffPavement++
    if (!clear) counts.stillOnPavement++
    if (sign < 0) counts.onTheLeft++
    const g = groundAt(p.x, p.z)
    p.y = g ?? m.z
    // THE ARM IS AS LONG AS IT HAS TO BE, and if that is absurd the mast does not belong here.
    //
    // A fixed arm from the lane count is right only if the pole ends up exactly at the kerb, and
    // it usually does not. Two ways it is off: the walk to clear ground at a wide junction can be
    // ten metres, and — the larger case, 36 of Crofton's 46 misses — the OSM node is simply not on
    // a carriageway we draw, sitting 10–20 m off it, so nothing moved and a minimum arm hung over
    // grass. So the reach is whichever is greater, what was walked sideways or what the pole's own
    // edge distance says, plus enough to get over the middle of the road.
    //
    // Past FURNITURE_ARM_MAX it stops being a mast arm. A signal whose road is fifteen metres away
    // is not governing that road, it is governing one we do not draw, and the honest thing is not
    // to place it rather than to grow a gantry out to it.
    // the arm points at the road: local +X when the pole is on the right of travel, local −X when
    // it had to go left. Walk that way and find where the asphalt actually starts — `edgeDistance`
    // is a SCALAR, so adding it to the arm reaches the nearest road in any direction, which at a
    // junction is as often the cross street or one behind as the one this signal governs.
    const armDir = sign < 0 ? right : right.clone().negate()
    let hit = -1
    for (let d = 0.5; d <= T.FURNITURE_ARM_MAX; d += 0.5) {
      if (edgeDistance(p.x + armDir.x * d, p.z + armDir.z * d) < 0) {
        hit = d
        break
      }
    }
    if (hit < 0) {
      // no carriageway in front of the arm within a mast arm's reach: this signal governs a road
      // we do not draw, and a gantry grown out to find one would be a lie
      counts.armNoRoad++
      continue
    }
    // rounded UP to an even metre: a bucket per exact length is a draw call per mast, and an arm
    // that is half a metre long is fine where one half a metre short leaves the heads off the road
    const armLen = Math.max(4, Math.min(T.FURNITURE_ARM_MAX, Math.ceil((hit + arm * 0.5) / 2) * 2))
    // bucket key carries the arm and the kerb side, so one geometry serves a band of widths and
    // the arm always reaches toward the road
    const key = (lanes * 1000 + armLen) * (sign < 0 ? -1 : 1)
    if (!byLanes.has(key)) byLanes.set(key, { arm: armLen, side: sign < 0 ? -1 : 1, at: [] })
    byLanes.get(key)!.at.push({ pos: p, yaw: m.yaw_deg, src: m })
    counts.masts++
  }
  for (const [key, b] of byLanes) {
    const lanes = Math.floor(Math.abs(key) / 1000)
    const geo = mastGeometry(lanes, b.arm, b.side)
    const mesh = new THREE.InstancedMesh(geo, metal, b.at.length)
    mesh.name = `furniture:signal:${lanes}${b.side < 0 ? 'L' : ''}`
    const mat4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const one = new THREE.Vector3(1, 1, 1)
    b.at.forEach((a, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(a.yaw * Math.PI) / 180)
      mat4.compose(a.pos, q, one)
      mesh.setMatrixAt(i, mat4)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.userData.src = b.at.map((a) => a.src)
    mesh.userData.arm = b.arm * b.side
    group.add(mesh)
  }

  // --- stop and give-way signs -----------------------------------------------------------------
  const bySign = new Map<'stop' | 'give_way', { pos: THREE.Vector3; yaw: number }[]>()
  for (const s of data.signs ?? []) {
    const kind = s.kind === 'stop' ? 'stop' : 'give_way'
    const b = (s.yaw_deg * Math.PI) / 180
    const headDir = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b))
    const travel = headDir.clone().negate()
    const right = new THREE.Vector3(-travel.z, 0, travel.x)
    const p0 = toWorld(s.x, s.y)
    if (!nearARoad(p0)) {
      counts.noRoadNearby++
      continue
    }
    const { p, moved, clear } = toKerb(p0, right, headDir)
    if (moved) counts.movedOffPavement++
    if (!clear) counts.stillOnPavement++
    p.y = groundAt(p.x, p.z) ?? s.z
    if (!bySign.has(kind)) bySign.set(kind, [])
    bySign.get(kind)!.push({ pos: p, yaw: s.yaw_deg })
    counts.signs++
  }
  for (const [kind, at] of bySign) {
    const mesh = new THREE.InstancedMesh(signGeometry(kind), metal, at.length)
    mesh.name = `furniture:sign:${kind}`
    const mat4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const one = new THREE.Vector3(1, 1, 1)
    at.forEach((a, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(a.yaw * Math.PI) / 180)
      mat4.compose(a.pos, q, one)
      mesh.setMatrixAt(i, mat4)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    group.add(mesh)
  }

  return { group, counts }
}
