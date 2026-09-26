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
import { BoundsIndex } from './strip'

const toWorld = (x: number, y: number) => new THREE.Vector3(x, 0, -y)

export interface FurnitureResult {
  group: THREE.Group
  counts: { masts: number; signs: number; movedOffPavement: number; stillOnPavement: number; onTheLeft: number; signsOnTheLeft: number; noRoadNearby: number; armNoRoad: number }
  /**
   * Where each mast ACTUALLY ended up, after the kerb walk and the arm measurement.
   *
   * A signal controller has to hang a lit lens under the right head, and only this module knows
   * where the head is: the bake gives the OSM node on the centreline, and the pole is then walked
   * back out of the junction box and sideways to clear ground, so the final position is a metre
   * or twenty from the one in the manifest. Published rather than re-derived, because re-deriving
   * it means re-implementing `toKerb` and the two would drift apart on the first tuning change.
   */
  placed: { pos: THREE.Vector3; yaw: number; arm: number; side: number; lanes: number; src: unknown }[]
}

/**
 * Where the lens centres of one mast sit, in the mast's own local frame.
 *
 * Exported so a controller can light them without re-deriving `mastGeometry`'s layout. The heads
 * hang under the arm and are spread along it; each carries three lenses on its −Z face, and these
 * are the same numbers `headGeometry` and `mastGeometry` build with.
 */
export function signalLensOffsets(lanes: number, arm: number, side: number): { x: number; y: number; z: number }[] {
  const H = T.FURNITURE_SIGNAL_HEIGHT
  const n = Math.max(1, Math.min(lanes, 6))
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.62 : 0.3 + (0.66 * i) / (n - 1)
    out.push({ x: side * arm * t, y: H - 0.9, z: -0.152 })
  }
  return out
}

/** lens height offsets within a head, red first — `headGeometry`'s LENS table. */
export const SIGNAL_LENS_Y = [0.3, 0.0, -0.3]

/**
 * A mesh builder that cuts what it is given into spatial chunks.
 *
 * Every one of these features is LINEAR and site-wide: Crofton has 34.9 km of fence and 80 km of
 * sidewalk spread over fifteen kilometres. Merged into one mesh each — which is the obvious way to
 * keep the draw calls down, and what `power.ts` does — the bounding sphere is the size of the site,
 * so frustum culling can never fire and every triangle is submitted every frame no matter where
 * the camera looks. Measured: 448 000 triangles of furniture took the frame from 33 ms to 1123 ms
 * on this (GPU-less) box.
 *
 * So: bucket by a coarse grid, one mesh per occupied cell, each with real bounds and culling ON.
 * More draw calls, almost all of them rejected before they cost anything.
 */
class Chunked {
  private cells = new Map<string, { pos: number[]; nor: number[]; col: number[]; idx: number[] }>()
  private size: number
  constructor(size: number) {
    this.size = size
  }
  private cell(x: number, z: number) {
    const k = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`
    let c = this.cells.get(k)
    if (!c) {
      c = { pos: [], nor: [], col: [], idx: [] }
      this.cells.set(k, c)
    }
    return c
  }
  /** a quad strip between two swept rings; both are (x, y, z, nx, nz, r, g, b) per profile point */
  strip(a: number[][], b: number[][]) {
    if (!a.length || a.length !== b.length) return
    const c = this.cell(a[0][0], a[0][2])
    const base = c.pos.length / 3
    for (const ring of [a, b]) {
      for (const v of ring) {
        c.pos.push(v[0], v[1], v[2])
        c.nor.push(v[3], 0, v[4])
        c.col.push(v[5], v[6], v[7])
      }
    }
    const n = a.length
    for (let k = 0; k + 1 < n; k++) {
      const a0 = base + k
      const a1 = base + k + 1
      const b0 = base + n + k
      const b1 = base + n + k + 1
      c.idx.push(a0, b0, b1, a0, b1, a1)
    }
  }
  /** a flat quad, four corners in order, one colour */
  quad(v: number[][], col: [number, number, number]) {
    const c = this.cell(v[0][0], v[0][2])
    const base = c.pos.length / 3
    for (const q of v) {
      c.pos.push(q[0], q[1], q[2])
      c.nor.push(0, 1, 0)
      c.col.push(col[0], col[1], col[2])
    }
    c.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  get isEmpty() {
    return this.cells.size === 0
  }
  /** one culled mesh per occupied cell */
  addTo(group: THREE.Group, name: string, material: THREE.Material) {
    let i = 0
    for (const c of this.cells.values()) {
      if (!c.idx.length) continue
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3))
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(c.nor, 3))
      geo.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3))
      geo.setIndex(c.idx)
      geo.computeVertexNormals()
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, material)
      mesh.name = `${name}:${i++}`
      group.add(mesh)
    }
  }
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

/**
 * The post and the back plate of a sign; the legend is a separate textured face (`signFace`),
 * because the post is vertex-coloured metal and the face is a painted picture, and one instanced
 * mesh cannot be both.
 */
function signPostGeometry(kind: 'stop' | 'give_way'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const H = T.FURNITURE_SIGN_HEIGHT
  const post = new THREE.CylinderGeometry(0.035, 0.035, H, 5)
  post.translate(0, H / 2, 0)
  parts.push(tint(post, 0x6e6e68))
  // the back, so it is not a hole when you drive past it. Same outline as the face.
  const back = signOutline(kind)
  back.translate(0, H - 0.05, 0.02)
  parts.push(tint(back, 0x8e8e88))
  return merge(parts)
}

/**
 * The outline of a sign, EDGE UP. `CircleGeometry(r, 8)` starts its first vertex at θ = 0, on the
 * +X axis, which puts a CORNER at the top and every edge 22.5° off the horizontal — Rich: "stop
 * signs are mounted like 22.5 degrees off" (2026-09-26). thetaStart = π/8 rotates the polygon half
 * a step so a flat edge is on top, which is how an octagon is hung.
 */
function signOutline(kind: 'stop' | 'give_way'): THREE.BufferGeometry {
  const g = kind === 'stop' ? new THREE.CircleGeometry(0.38, 8, Math.PI / 8) : new THREE.CircleGeometry(0.45, 3, -Math.PI / 2)
  g.rotateY(Math.PI) // face −Z, the way every head here faces
  return g
}

/** The painted face, its texture drawn once and shared by every sign of that kind on the site. */
function signFace(kind: 'stop' | 'give_way'): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } {
  const geometry = signOutline(kind)
  geometry.translate(0, T.FURNITURE_SIGN_HEIGHT - 0.05, -0.04)
  const material = new THREE.MeshStandardMaterial({ map: signTexture(kind), roughness: 0.55, metalness: 0.05 })
  return { geometry, material }
}

const signTextures = new Map<string, THREE.CanvasTexture>()
/**
 * The legend as a canvas: MUTCD R1-1 for stop — red field, white border, white STOP — and R1-2
 * for give way. `CircleGeometry`'s UVs map the polygon's bounding square to 0..1, so the picture
 * is drawn on a square and the geometry clips it to the outline; the border is drawn as its own
 * inset polygon so it is white in the texture, not a rim the geometry happens to leave.
 */
function signTexture(kind: 'stop' | 'give_way'): THREE.CanvasTexture {
  const had = signTextures.get(kind)
  if (had) return had
  const S = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = S
  const ctx = cv.getContext('2d')!
  const poly = (n: number, r: number, start: number) => {
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const a = start + (i / n) * Math.PI * 2
      const x = S / 2 + Math.cos(a) * r, y = S / 2 - Math.sin(a) * r
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }
  if (kind === 'stop') {
    // white behind everything, then the red field inset — the ring between them is the border
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, S, S)
    poly(8, S / 2 - 14, Math.PI / 8)
    ctx.fillStyle = '#b8261f'
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    // R1-1 proportions: the legend is about 60 % of the sign's width, with clear red either side
    // — "stop signs and street signs need a little padding around the text" (Rich, 2026-09-26)
    ctx.font = `bold ${Math.round(S * 0.27)}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('STOP', S / 2, S / 2 + 4)
  } else {
    // give way: white triangle, red border, point down. The geometry's UV square is the triangle's
    // bounding box, so the drawing uses the same start angle the outline does.
    ctx.fillStyle = '#c62828'
    ctx.fillRect(0, 0, S, S)
    poly(3, S / 2 - 22, -Math.PI / 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.fillStyle = '#c62828'
    ctx.font = `bold ${Math.round(S * 0.11)}px "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('YIELD', S / 2, S / 2 - 22)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  signTextures.set(kind, tex)
  return tex
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
  const counts = { masts: 0, signs: 0, movedOffPavement: 0, stillOnPavement: 0, onTheLeft: 0, signsOnTheLeft: 0, noRoadNearby: 0, armNoRoad: 0 }
  const placed: FurnitureResult['placed'] = []
  const data = manifest.signals
  if (!data) return { group, counts, placed }

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
  const toKerb = (p: THREE.Vector3, side: THREE.Vector3, back: THREE.Vector3, rightFirstM = 0): { p: THREE.Vector3; moved: boolean; clear: boolean; sign: number } => {
    const want = T.FURNITURE_KERB_CLEAR
    if (edgeDistance(p.x, p.z) >= want) return { p, moved: false, clear: true, sign: 1 }
    const step = 0.5
    // RIGHT FIRST, when the caller says the right matters more than the distance.
    //
    // The search below is ordered (step back, then sideways distance, then side), so a nearer LEFT
    // always beats a farther RIGHT. For a mast that is the right trade — it is hung over the road
    // either way and the geometry mirrors. For a STOP SIGN it is not: an American stop sign is on
    // the right, and a sign on the left of a two-way street reads as wrong to anyone who drives.
    //
    // Measured on crofton-triangle before this: 179 of 572 stop signs (31 %) stood on the left. The
    // cause is that a stop sign is placed at the STOP LINE, 6 m into the junction's paved throat,
    // where walking right crosses the cross street's asphalt — 140 of the 179 had no clear ground
    // to the right at that setback at all, out to the full 26 m. Stepping back 2-12 m first clears
    // it for 176 of them, and the right-hand search below does exactly that before it gives up.
    if (rightFirstM > 0) {
      const q0 = new THREE.Vector3()
      const f0 = new THREE.Vector3()
      for (let b = 0; b <= T.FURNITURE_SETBACK_MAX; b += 2) {
        f0.set(p.x + back.x * b, 0, p.z + back.z * b)
        for (let d = step; d <= rightFirstM; d += step) {
          q0.set(f0.x + side.x * d, 0, f0.z + side.z * d)
          if (edgeDistance(q0.x, q0.z) >= want) return { p: q0.clone(), moved: true, clear: true, sign: 1 }
        }
      }
    }
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
    // A FAR-SIDE mast (the bake puts a signal's pole across the junction from the traffic it
    // controls, where a driver at the stop line sees it ahead rather than straight up) must walk
    // ONWARD past the junction to find its kerb, not back toward the traffic — back is into the
    // box — and it must land on the right, the far-right corner, so the arm reaches back over the
    // approach's lanes. A near-side record (an older bake) keeps the old walk.
    const { p, moved, clear, sign } = m.far_side ? toKerb(p0, right, travel, T.FURNITURE_SIGN_RIGHT_M) : toKerb(p0, right, headDir)
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
    for (const a of b.at) placed.push({ pos: a.pos, yaw: a.yaw, arm: b.arm, side: b.side, lanes, src: a.src })
    group.add(mesh)
  }

  // --- stop and give-way signs -----------------------------------------------------------------
  const bySign = new Map<'stop' | 'give_way', { pos: THREE.Vector3; yaw: number; src: unknown }[]>()
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
    const { p, moved, clear, sign } = toKerb(p0, right, headDir, T.FURNITURE_SIGN_RIGHT_M)
    if (moved) counts.movedOffPavement++
    if (!clear) counts.stillOnPavement++
    if (sign < 0) counts.signsOnTheLeft++
    p.y = groundAt(p.x, p.z) ?? s.z
    if (!bySign.has(kind)) bySign.set(kind, [])
    bySign.get(kind)!.push({ pos: p, yaw: s.yaw_deg, src: s })
    counts.signs++
  }
  for (const [kind, at] of bySign) {
    // two instanced meshes with the same transforms: the metal (post + back plate) and the
    // painted face. `furniture:sign:<kind>` keeps its name so the probes that count signs and
    // read `userData.src` per instance are unchanged.
    const face = signFace(kind)
    const mesh = new THREE.InstancedMesh(signPostGeometry(kind), metal, at.length)
    mesh.name = `furniture:sign:${kind}`
    const faces = new THREE.InstancedMesh(face.geometry, face.material, at.length)
    faces.name = `furniture:sign:${kind}:face`
    const mat4 = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const one = new THREE.Vector3(1, 1, 1)
    at.forEach((a, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(a.yaw * Math.PI) / 180)
      mat4.compose(a.pos, q, one)
      mesh.setMatrixAt(i, mat4)
      faces.setMatrixAt(i, mat4)
    })
    mesh.instanceMatrix.needsUpdate = true
    faces.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    faces.frustumCulled = false
    // the source record per instance, in instance order — so a probe can ask whether a sign faces
    // the traffic it stops, which is the one thing about a sign that a screenshot cannot show
    mesh.userData.src = at.map((a) => a.src)
    group.add(mesh)
    group.add(faces)
  }

  return { group, counts, placed }
}

// --- barriers: guard rail, fence, wall, hedge ------------------------------------------------
//
// Guard rail is the one that matters for a rural road, and the acceptance site does not have any:
// Crofton is suburban arterials with 178 fences, 24 walls, 3 hedges and ZERO guard rail, while
// frederick-i70 has 39 runs of it and frederick-i270 has 22. It is an interstate feature in this
// region. So it is built to the real profile and proven on frederick-i70.
//
// A W-beam is not a plank. What your eye reads at speed is the two corrugations catching the light
// along their length, so the beam is swept as a five-point profile — out, in, out, in, out — which
// is four quad strips per segment and the only thing that makes it look like highway rail rather
// than a fence board.

/** A cross-section, swept along a way: lateral offset from the line, and height above the ground. */
type Profile = { out: number; y: number }[]

const PROFILE: Record<string, { profile: Profile; colour: number; postEvery: number; postW: number; postColour: number }> = {
  // 0.72 m to the top of the beam, the US standard; posts every 2 m (6'3" in practice)
  guard_rail: {
    profile: [
      { out: 0, y: 0.42 },
      { out: 0.06, y: 0.52 },
      { out: 0, y: 0.6 },
      { out: 0.06, y: 0.68 },
      { out: 0, y: 0.76 },
    ],
    colour: 0x9aa0a4,
    postEvery: 2,
    postW: 0.14,
    postColour: 0x7c8286,
  },
  fence: {
    profile: [
      { out: 0, y: 0.35 },
      { out: 0, y: 0.38 },
      { out: 0, y: 1.0 },
      { out: 0, y: 1.03 },
    ],
    colour: 0x8d8b82,
    postEvery: 2.5,
    postW: 0.08,
    postColour: 0x6f6d66,
  },
  wall: {
    profile: [
      { out: -0.12, y: 0 },
      { out: -0.12, y: 1 },
      { out: 0.12, y: 1 },
      { out: 0.12, y: 0 },
    ],
    colour: 0x9e9a90,
    postEvery: 0,
    postW: 0,
    postColour: 0x9e9a90,
  },
  // a retaining wall has no posts; without its own entry it fell through to the fence profile and
  // grew 94 of them on Crofton
  retaining_wall: {
    profile: [
      { out: -0.18, y: 0 },
      { out: -0.14, y: 1 },
      { out: 0.14, y: 1 },
      { out: 0.18, y: 0 },
    ],
    colour: 0x8f8b83,
    postEvery: 0,
    postW: 0,
    postColour: 0x8f8b83,
  },
  hedge: {
    profile: [
      { out: -0.45, y: 0.05 },
      { out: -0.38, y: 0.75 },
      { out: 0, y: 1 },
      { out: 0.38, y: 0.75 },
      { out: 0.45, y: 0.05 },
    ],
    colour: 0x46612f,
    postEvery: 0,
    postW: 0,
    postColour: 0x46612f,
  },
}

export interface BarrierResult {
  group: THREE.Group
  counts: Record<string, { runs: number; metres: number; posts: number }>
}

/**
 * Build every barrier on the site.
 *
 * The profile is swept along each way with the height scaled to whatever OSM said (or the kind's
 * default), so a 3 m city wall and a 1.5 m garden fence come out of the same code. `wall` and
 * `hedge` scale their whole profile, including the lateral spread — a tall hedge is a fat hedge —
 * while a guard rail does not, because a W-beam is the same beam whatever the post height.
 */
export function buildBarriers(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
): BarrierResult {
  const group = new THREE.Group()
  group.name = 'barriers'
  const counts: Record<string, { runs: number; metres: number; posts: number }> = {}
  const runs = manifest.barriers ?? []
  if (!runs.length) return { group, counts }

  const byKind = new Map<string, { chunks: Chunked; posts: { x: number; y: number; z: number; yaw: number; h: number }[] }>()

  for (const run of runs) {
    const spec = PROFILE[run.kind] ?? PROFILE.fence
    const c = new THREE.Color(spec.colour)
    if (!byKind.has(run.kind)) byKind.set(run.kind, { chunks: new Chunked(T.FURNITURE_CHUNK_M), posts: [] })
    const b = byKind.get(run.kind)!
    const st = (counts[run.kind] ??= { runs: 0, metres: 0, posts: 0 })
    st.runs++

    // the way, in world coordinates, on the ground
    const pts = run.coords.map((p) => {
      const x = p[0]
      const z = -p[1]
      return { x, z, y: groundAt(x, z) ?? p[2] }
    })
    if (pts.length < 2) continue

    // height: OSM's where it had one, scaled by the knob. A guard rail keeps its beam profile and
    // only its posts grow; a wall or a hedge scales bodily.
    const hScale = (run.height_m || 1) * T.BARRIER_HEIGHT_SCALE
    const bodily = run.kind === 'wall' || run.kind === 'hedge' || run.kind === 'retaining_wall'
    const prof = spec.profile.map((q) => ({ out: bodily ? q.out * hScale : q.out, y: bodily ? q.y * hScale : q.y * T.BARRIER_HEIGHT_SCALE }))

    let ring: number[][] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]
      const d = pts[Math.min(pts.length - 1, i + 1)]
      const dx = d.x - a.x
      const dz = d.z - a.z
      const l = Math.hypot(dx, dz) || 1
      const px = -dz / l
      const pz = dx / l
      const here = prof.map((q) => [pts[i].x + px * q.out, pts[i].y + q.y, pts[i].z + pz * q.out, px, pz, c.r, c.g, c.b])
      if (i > 0) {
        b.chunks.strip(ring, here)
        st.metres += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
      }
      ring = here
    }

    // posts, spaced along the run rather than per vertex — the bake puts a vertex every 2 m but a
    // fence wants one every 2.5 and a rail every 2, and a short segment must not get a post pile
    if (spec.postEvery > 0) {
      let carried = 0
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x
        const dz = pts[i].z - pts[i - 1].z
        const seg = Math.hypot(dx, dz)
        const yaw = Math.atan2(dx, dz)
        for (let t = spec.postEvery - carried; t < seg; t += spec.postEvery) {
          const u = t / seg
          b.posts.push({
            x: pts[i - 1].x + dx * u,
            z: pts[i - 1].z + dz * u,
            y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u,
            yaw,
            h: prof[prof.length - 1].y,
          })
          st.posts++
        }
        carried = (carried + seg) % spec.postEvery
      }
    }
  }

  for (const [kind, b] of byKind) {
    const spec = PROFILE[kind] ?? PROFILE.fence
    if (!b.chunks.isEmpty) {
      b.chunks.addTo(group, `barrier:${kind}`, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'hedge' ? 0.95 : 0.6, metalness: kind === 'guard_rail' ? 0.4 : 0, side: THREE.DoubleSide }))
    }
    if (b.posts.length) {
      // the posts are chunked as well: 13 870 fence posts in one InstancedMesh is one draw call
      // that can never be culled, and a fence post is 12 triangles, so that is 166 000 of them
      // submitted from anywhere on the site
      const byCell = new Map<string, typeof b.posts>()
      for (const p of b.posts) {
        const k = `${Math.floor(p.x / T.FURNITURE_CHUNK_M)},${Math.floor(p.z / T.FURNITURE_CHUNK_M)}`
        const arr = byCell.get(k) ?? []
        arr.push(p)
        byCell.set(k, arr)
      }
      const postMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.3 })
      let ci = 0
      for (const arr of byCell.values()) {
        const g = new THREE.BoxGeometry(spec.postW, 1, spec.postW * 0.6)
        g.translate(0, 0.5, 0)
        tint(g, spec.postColour)
        const mesh = new THREE.InstancedMesh(g, postMat, arr.length)
        mesh.name = `barrier:${kind}:posts:${ci++}`
        const m4 = new THREE.Matrix4()
        const q = new THREE.Quaternion()
        const up = new THREE.Vector3(0, 1, 0)
        arr.forEach((p, i) => {
          q.setFromAxisAngle(up, p.yaw)
          m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, p.h, 1))
          mesh.setMatrixAt(i, m4)
        })
        mesh.instanceMatrix.needsUpdate = true
        mesh.computeBoundingSphere()
        group.add(mesh)
      }
    }
  }
  for (const k of Object.keys(counts)) counts[k].metres = Math.round(counts[k].metres)
  return { group, counts }
}

// --- sidewalks, kerbs and crossings -----------------------------------------------------------
//
/**
 * Is this world point on a sidewalk? For the grass planter, which used to grow turf straight
 * through every walk — "sidewalks have grass growing over them" (Rich, 2026-09-26) — because it
 * only knew the road's edge. Polylines bucketed by bounds; a hit is within half the walk's width
 * plus a small margin of any segment. The verge between kerb and walk keeps its grass.
 */
export function sidewalkCover(manifest: Manifest, margin = 0.35): (x: number, z: number) => boolean {
  const runs = (manifest.sidewalks ?? []).filter((r) => r.kind === 'sidewalk' && r.coords.length > 1)
  if (!runs.length) return () => false
  const items = runs.map((r) => {
    const pts = r.coords.map(([x, y]) => [x, -y] as [number, number])
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (const [x, z] of pts) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (z < z0) z0 = z
      if (z > z1) z1 = z
    }
    const half = (r.width_m || 1.5) / 2 + margin
    return { pts, half, bounds: [x0 - half, z0 - half, x1 + half, z1 + half] as [number, number, number, number] }
  })
  const index = new BoundsIndex(items, 250, 1)
  const near = (it: (typeof items)[number], x: number, z: number): true | null => {
    const h2 = it.half * it.half
    const p = it.pts
    for (let i = 1; i < p.length; i++) {
      const [ax, az] = p[i - 1], [bx, bz] = p[i]
      const dx = bx - ax, dz = bz - az
      const len2 = dx * dx + dz * dz
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0
      const qx = ax + u * dx - x, qz = az + u * dz - z
      if (qx * qx + qz * qz < h2) return true
    }
    return null
  }
  return (x, z) => index.firstAt(x, z, (it) => near(it, x, z)) === true
}
//
// Crofton maps 626 `footway=sidewalk` ways and 446 `footway=crossing` ways explicitly, and another
// 78 roads say `sidewalk=both|left|right` with no separate geometry — the same walk, recorded as
// an attribute instead of a line, and offset off the carriageway in the bake.
//
// What makes a sidewalk read as one rather than as a grey stripe is the KERB: a vertical lip on
// the road side, about 150 mm, catching a different light from the walking surface. So the ribbon
// is a three-point swept profile — kerb foot, kerb top, back edge — and the only interesting part
// is which side the kerb goes on, because a sidewalk way carries no such tag. It is found by
// measurement: sample `edgeDistance` a couple of metres either side and put the kerb toward the
// asphalt. Where neither side is near a road the lip goes flat, which is right, because that is a
// path through a park and not a sidewalk.
//
// A DROPPED KERB is not decoration either. The lip fades to nothing over the last couple of metres
// before a crossing, which is what the ramp at a corner is, and it is why the kerb height is a
// per-vertex value rather than a constant in the profile.

export interface SidewalkResult {
  group: THREE.Group
  counts: { walks: number; crossings: number; marked: number; bars: number; metres: number; kerbFlat: number }
}

export function buildSidewalks(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): SidewalkResult {
  const group = new THREE.Group()
  group.name = 'sidewalks'
  const counts = { walks: 0, crossings: 0, marked: 0, bars: 0, metres: 0, kerbFlat: 0 }
  const runs = manifest.sidewalks ?? []
  if (!runs.length) return { group, counts }

  const concrete = new Chunked(T.FURNITURE_CHUNK_M)
  const bars = new Chunked(T.FURNITURE_CHUNK_M)
  const cWalk = new THREE.Color(0xb4b2ab)
  const cKerb = new THREE.Color(0xa09e97)

  // every crossing end, so a kerb can be dropped where a walk meets one
  const ends: { x: number; z: number }[] = []
  for (const r of runs) {
    if (r.kind !== 'crossing') continue
    for (const e of [r.coords[0], r.coords[r.coords.length - 1]]) ends.push({ x: e[0], z: -e[1] })
  }
  const nearCrossing = (x: number, z: number) => {
    let best = Infinity
    for (const e of ends) {
      const d = (e.x - x) ** 2 + (e.z - z) ** 2
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }

  for (const r of runs) {
    const pts = r.coords.map((p) => {
      const x = p[0]
      const z = -p[1]
      return { x, z, y: groundAt(x, z) ?? p[2] }
    })
    if (pts.length < 2) continue

    if (r.kind === 'crossing') {
      counts.crossings++
      if (!r.marked) continue
      counts.marked++
      // a ladder crossing: bars across the walk, along its length
      const w = Math.max(1.5, r.width_m) * T.SIDEWALK_CROSSING_W
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x
        const dz = pts[i].z - pts[i - 1].z
        const seg = Math.hypot(dx, dz)
        if (seg < 0.1) continue
        const ux = dx / seg
        const uz = dz / seg
        const px = -uz
        const pz = ux
        for (let t = T.SIDEWALK_BAR_PITCH / 2; t < seg; t += T.SIDEWALK_BAR_PITCH) {
          const u = t / seg
          const cxp = pts[i - 1].x + dx * u
          const czp = pts[i - 1].z + dz * u
          const cy = (pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u) + T.SIDEWALK_PAINT_LIFT
          // a bar runs ACROSS the crossing line, which is along the traffic's direction
          const hb = T.SIDEWALK_BAR_W / 2
          bars.quad([
            [cxp + px * (w / 2) + ux * hb, cy, czp + pz * (w / 2) + uz * hb],
            [cxp - px * (w / 2) + ux * hb, cy, czp - pz * (w / 2) + uz * hb],
            [cxp - px * (w / 2) - ux * hb, cy, czp - pz * (w / 2) - uz * hb],
            [cxp + px * (w / 2) - ux * hb, cy, czp + pz * (w / 2) - uz * hb],
          ], [0.85, 0.85, 0.82])
          counts.bars++
        }
      }
      continue
    }

    counts.walks++
    const w = Math.max(0.9, r.width_m) * T.SIDEWALK_WIDTH_SCALE
    let ring: number[][] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]
      const d = pts[Math.min(pts.length - 1, i + 1)]
      const dx = d.x - a.x
      const dz = d.z - a.z
      const l = Math.hypot(dx, dz) || 1
      const px = -dz / l
      const pz = dx / l
      // which side is the road? measure, rather than guess: a sidewalk way carries no such tag
      const probe = T.SIDEWALK_KERB_PROBE
      const eL = edgeDistance(pts[i].x + px * probe, pts[i].z + pz * probe)
      const eR = edgeDistance(pts[i].x - px * probe, pts[i].z - pz * probe)
      const side = eL < eR ? 1 : -1
      const nearest = Math.min(eL, eR)
      // no road either side: a path through a park, and it has no kerb
      let kerb = nearest > T.SIDEWALK_KERB_MAX_FROM_ROAD ? 0 : T.SIDEWALK_KERB_H
      if (kerb === 0) counts.kerbFlat++
      // and the lip ramps away at a crossing — that is what a dropped kerb is
      const dc = nearCrossing(pts[i].x, pts[i].z)
      if (dc < T.SIDEWALK_DROP_M) kerb *= dc / T.SIDEWALK_DROP_M
      const profile = [
        { out: (side * w) / 2, y: 0, c: cKerb },
        { out: (side * w) / 2, y: kerb + T.SIDEWALK_LIFT, c: cKerb },
        { out: (-side * w) / 2, y: kerb + T.SIDEWALK_LIFT, c: cWalk },
      ]
      const here = profile.map((q) => [pts[i].x + px * q.out, pts[i].y + q.y, pts[i].z + pz * q.out, 0, 1, q.c.r, q.c.g, q.c.b])
      if (i > 0) {
        concrete.strip(ring, here)
        counts.metres += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)
      }
      ring = here
    }
  }

  concrete.addTo(group, 'sidewalk:concrete', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }))
  bars.addTo(group, 'sidewalk:crossingbars', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }))
  counts.metres = Math.round(counts.metres)
  return { group, counts }
}
