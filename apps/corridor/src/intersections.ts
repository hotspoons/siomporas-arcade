// What happens where two roads meet: signals that actually cycle, stop bars, and street name blades.
//
// The bake (`corridor/intersections.py`) works out the junction graph, who stops, and which arms
// share a phase. This module draws it and runs the clock.
//
// THE CONTROLLER is the piece that was missing. street-furniture built the masts and deliberately
// left the heads dark, because "a signal cycling to a timer that has no relationship to the
// junction is worse than an unlit one, because it invites you to obey it". The bake now gives the
// relationship — every mast carries the junction it belongs to and the phase group it runs with —
// so the timer means something and the lenses can light.
//
// Three properties it has to have:
//
//   DETERMINISTIC   the phase is a pure function of wall-clock time, not of frames rendered. A
//                   controller driven by a frame counter runs at a different speed on every
//                   machine and stops entirely when the tab is backgrounded.
//   DESYNCHRONISED  every junction is offset by a hash of its own id. Without it, all twelve of
//                   Crofton's signals go green in the same frame, which no city has ever looked
//                   like.
//   CHEAP           one InstancedMesh of lit lenses for the whole site, updated by writing an
//                   instance colour. Crofton's twelve junctions are 41 masts and 117 heads, so the
//                   per-frame work is 117 colour writes and one buffer upload.
//
// The lit lens is drawn IN FRONT of the dark one the mast geometry already carries, rather than by
// recolouring it: the mast is one merged geometry per lane-count bucket, so its vertex colours are
// shared by every instance in the bucket and cannot say anything per-signal.
import * as THREE from 'three'
import { SIGNAL_LENS_Y, signalLensOffsets, type FurnitureResult } from './furniture'
import type { Manifest } from './site'
import * as T from './tuning'

const toWorld = (x: number, y: number) => new THREE.Vector3(x, 0, -y)

/** stable small offset per junction, so they do not all switch together */
function hashOffset(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

export interface SignalsResult {
  group: THREE.Group
  counts: { junctions: number; lit: number; masts: number; phases: number }
  /** advance the clock; `t` is seconds and must be wall-clock, not a frame count */
  tick: (t: number) => void
}

type Phase = { arms: number[]; green_s: number; amber_s: number; all_red_s: number; superior: boolean }

/**
 * The lit lenses, and the clock that drives them.
 *
 * A phase's own timeline is green -> amber -> all-red, and every OTHER phase is red for the whole
 * of it. That is a real fixed-time controller: there is no demand, no detector and no pedestrian
 * stage, and pretending otherwise would need data the bake does not have.
 */
export function buildSignals(manifest: Manifest, placed: FurnitureResult['placed']): SignalsResult {
  const group = new THREE.Group()
  group.name = 'signals'
  const counts = { junctions: 0, lit: 0, masts: 0, phases: 0 }
  const model = manifest.intersections?.list ?? []
  const byId = new Map<string, { phases: Phase[]; cycle: number; offset: number }>()
  for (const X of model) {
    if (X.control !== 'signals' || !X.phases?.length) continue
    // durations are knobs, so the bake's numbers are a default and Rich can drive them
    const phases: Phase[] = X.phases.map((p) => ({
      arms: p.arms,
      green_s: X.phases.length > 2 ? T.SIGNAL_GREEN_RR : p.superior ? T.SIGNAL_GREEN_MAJOR : T.SIGNAL_GREEN_MINOR,
      amber_s: T.SIGNAL_AMBER,
      all_red_s: T.SIGNAL_ALL_RED,
      superior: p.superior,
    }))
    const cycle = phases.reduce((s, p) => s + p.green_s + p.amber_s + p.all_red_s, 0)
    if (cycle <= 0) continue
    byId.set(X.id, { phases, cycle, offset: hashOffset(X.id) * cycle })
    counts.junctions++
    counts.phases += phases.length
  }
  if (!byId.size) return { group, counts, tick: () => {} }

  // one lens per head, positioned from the mast's own placement
  const lens = new THREE.CircleGeometry(T.SIGNAL_LENS_R, 12)
  lens.rotateY(Math.PI) // face −Z, like the dark lens it sits in front of
  const items: { x: string; phase: number }[] = []
  const mats: THREE.Matrix4[] = []
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const m4 = new THREE.Matrix4()
  const one = new THREE.Vector3(1, 1, 1)
  const off = new THREE.Vector3()
  for (const p of placed) {
    const src = p.src as { x_id?: string; phase?: number } | undefined
    if (!src?.x_id || !byId.has(src.x_id)) continue
    counts.masts++
    q.setFromAxisAngle(up, -(p.yaw * Math.PI) / 180)
    for (const h of signalLensOffsets(p.lanes, p.arm, p.side)) {
      // the three lenses of one head occupy one instance slot each so a single colour write can
      // light exactly one of them
      for (let li = 0; li < 3; li++) {
        off.set(h.x, h.y + SIGNAL_LENS_Y[li], h.z - 0.006).applyQuaternion(q).add(p.pos)
        m4.compose(off.clone(), q.clone(), one)
        mats.push(m4.clone())
        items.push({ x: src.x_id, phase: src.phase ?? 0 })
      }
    }
  }
  if (!mats.length) return { group, counts, tick: () => {} }

  // unlit: a MeshBasicMaterial at near-black, so an instance that is not showing is invisible
  // against the dark housing rather than a grey disc floating in front of it
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 1 })
  const mesh = new THREE.InstancedMesh(lens, mat, mats.length)
  mesh.name = 'signals:lenses'
  for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i])
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
  const dark = new THREE.Color(0x0a0c0d)
  const LIT = [new THREE.Color(0xff2a20), new THREE.Color(0xffb020), new THREE.Color(0x22e04a)]
  for (let i = 0; i < mats.length; i++) mesh.setColorAt(i, dark)
  counts.lit = mats.length / 3
  group.add(mesh)

  const c = new THREE.Color()
  const tick = (t: number) => {
    for (let i = 0; i < items.length; i += 3) {
      const it = items[i]
      const J = byId.get(it.x)!
      let u = (t * T.SIGNAL_RATE + J.offset) % J.cycle
      // which phase owns the clock right now, and what is this arm's aspect?
      let showing = 0 // 0 red, 1 amber, 2 green
      for (let pi = 0; pi < J.phases.length; pi++) {
        const P = J.phases[pi]
        const span = P.green_s + P.amber_s + P.all_red_s
        if (u < span) {
          if (pi === it.phase) showing = u < P.green_s ? 2 : u < P.green_s + P.amber_s ? 1 : 0
          break
        }
        u -= span
      }
      for (let li = 0; li < 3; li++) {
        c.copy(showing === 2 - li ? LIT[li] : dark)
        mesh.setColorAt(i + li, c)
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }
  tick(0)
  return { group, counts, tick }
}

// --- stop bars ---------------------------------------------------------------------------------
//
// Rich: "Stop signs if we have them, please put them with a line in the direction of travel."
//
// The bar goes ACROSS the lane at the stop line, which the bake set back from the junction centre
// by half the widest cross street — that is where it is painted in the real world and it is the
// only setback that keeps it off the cross street's own asphalt.
//
// It is clipped to the carriageway by measurement rather than by the nominal width: `edgeDistance`
// is walked out from the centre until it leaves the asphalt, so a bar never runs out over the verge
// on a narrow court or stop short on a widened approach.

export interface BarsResult {
  group: THREE.Group
  counts: { bars: number; metres: number; clipped: number; noRoad: number }
}

export function buildStopBars(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): BarsResult {
  const group = new THREE.Group()
  group.name = 'stopbars'
  const counts = { bars: 0, metres: 0, clipped: 0, noRoad: 0 }
  const bars = manifest.signals?.bars ?? []
  if (!bars.length) return { group, counts }

  const pos: number[] = []
  const idx: number[] = []
  for (const b of bars) {
    const p = toWorld(b.x, b.y)
    if (edgeDistance(p.x, p.z) > T.STOPBAR_MAX_FROM_ROAD) {
      counts.noRoad++
      continue
    }
    const th = (b.travel_deg * Math.PI) / 180
    const travel = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th))
    const across = new THREE.Vector3(-travel.z, 0, travel.x)
    // how wide is the asphalt here? walk out both ways until it ends
    const reach = (sgn: number) => {
      let d = 0
      for (let k = 0.25; k <= b.width_m; k += 0.25) {
        if (edgeDistance(p.x + across.x * k * sgn, p.z + across.z * k * sgn) >= 0) break
        d = k
      }
      return d
    }
    const rL = reach(1)
    const rR = reach(-1)
    if (rL + rR < 1.0) {
      counts.noRoad++
      continue
    }
    if (rL + rR < b.width_m - 0.5) counts.clipped++
    // a stop bar spans the APPROACH lanes only, which on a two-way road is the half you are on
    const half = b.width_m / 2
    const a0 = Math.min(rL, half)
    const a1 = Math.min(rR, half)
    const hw = T.STOPBAR_DEPTH / 2
    const corners = [
      [a0, hw], [-a1, hw], [-a1, -hw], [a0, -hw],
    ] as [number, number][]
    const base = pos.length / 3
    for (const [u, v] of corners) {
      const x = p.x + across.x * u + travel.x * v
      const z = p.z + across.z * u + travel.z * v
      pos.push(x, (groundAt(x, z) ?? b.z) + T.STOPBAR_LIFT, z)
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    counts.bars++
    counts.metres += a0 + a1
  }
  if (!counts.bars) return { group, counts }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.85, metalness: 0 }))
  mesh.name = 'stopbars:paint'
  group.add(mesh)
  counts.metres = Math.round(counts.metres)
  return { group, counts }
}

// --- street name blades -------------------------------------------------------------------------
//
// Rich: "prefer the far right corner from superior road in the direction of travel - close right
// for inferior road, figure out a tie breaker."
//
// The bake picks the corner (both rules select the same one — see `intersections._blades`) and
// hands over two candidates in preference order. Only the viewer can say whether a candidate is
// standing in the road, so it takes the first one that is clear.
//
// ONE TEXTURE for the whole site. Every distinct name is drawn once into a grid atlas and each
// blade is a quad with the right cell's UVs, which makes 853 blades on Crofton one draw call
// instead of 853 materials.

export interface BladesResult {
  group: THREE.Group
  counts: { junctions: number; blades: number; truncated: number; fellBack: number; noCorner: number; atlas: string }
}

const CELL_W = 256
const CELL_H = 48
const COLS = 16

function bladeAtlas(texts: string[]): { tex: THREE.CanvasTexture; uv: Map<string, [number, number, number, number]>; size: string } {
  const rows = Math.max(1, Math.ceil(texts.length / COLS))
  const cv = document.createElement('canvas')
  cv.width = CELL_W * COLS
  cv.height = CELL_H * rows
  const ctx = cv.getContext('2d')!
  const uv = new Map<string, [number, number, number, number]>()
  ctx.clearRect(0, 0, cv.width, cv.height)
  texts.forEach((t, i) => {
    const cx = (i % COLS) * CELL_W
    const cy = Math.floor(i / COLS) * CELL_H
    ctx.fillStyle = '#12613a' // Maryland street blades are green with white legend
    ctx.fillRect(cx, cy, CELL_W, CELL_H)
    ctx.strokeStyle = '#eef2ee'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 3, cy + 3, CELL_W - 6, CELL_H - 6)
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // shrink to fit rather than overflow: the bake has already truncated to the character budget,
    // and this is the backstop for a name that is short but wide
    let px = 30
    do {
      ctx.font = `600 ${px}px system-ui, sans-serif`
      if (ctx.measureText(t).width <= CELL_W - 22) break
      px -= 2
    } while (px > 10)
    ctx.fillText(t, cx + CELL_W / 2, cy + CELL_H / 2 + 1)
    uv.set(t, [cx / cv.width, 1 - (cy + CELL_H) / cv.height, CELL_W / cv.width, CELL_H / cv.height])
  })
  const tex = new THREE.CanvasTexture(cv)
  tex.anisotropy = 8
  tex.needsUpdate = true
  return { tex, uv, size: `${cv.width}x${cv.height}` }
}

export function buildBlades(
  manifest: Manifest,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): BladesResult {
  const group = new THREE.Group()
  group.name = 'blades'
  const counts = { junctions: 0, blades: 0, truncated: 0, fellBack: 0, noCorner: 0, atlas: '-' }
  const model = manifest.intersections?.list ?? []
  if (!model.length) return { group, counts }

  const texts = [...new Set(model.flatMap((X) => (X.blades ?? []).map((b) => b.text)))].filter(Boolean)
  if (!texts.length) return { group, counts }
  const { tex, uv, size } = bladeAtlas(texts)
  counts.atlas = size

  const pos: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  const postPos: number[] = []
  const postIdx: number[] = []

  const quad = (cx: number, cy: number, cz: number, yaw: number, w: number, h: number, cell: [number, number, number, number]) => {
    const th = (yaw * Math.PI) / 180
    // the blade runs parallel to the road it names; its face normal is across that
    const ax = Math.sin(th)
    const az = -Math.cos(th)
    const [u0, v0, du, dv] = cell
    for (const flip of [1, -1]) {
      const base = pos.length / 3
      const c = [
        [-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2],
      ] as [number, number][]
      for (const [u, v] of c) {
        pos.push(cx + ax * u * flip, cy + v, cz + az * u * flip)
      }
      // both faces read correctly: the back sheet mirrors its UVs rather than the text
      const t = flip > 0
        ? [[u0, v0 + dv], [u0 + du, v0 + dv], [u0 + du, v0], [u0, v0]]
        : [[u0 + du, v0 + dv], [u0, v0 + dv], [u0, v0], [u0 + du, v0]]
      for (const [a, b] of t) uvs.push(a, b)
      if (flip > 0) idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
      else idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  for (const X of model) {
    const blades = X.blades ?? []
    const corners = X.corners ?? []
    if (blades.length < 2 || !corners.length) continue
    // The first candidate that is clear of the asphalt, WALKING OUTWARD if it is not.
    //
    // The bake puts each corner at a nominal radius from the junction centre, and it cannot know
    // whether that lands on asphalt: at a wide crossing with turn radii the pavement reaches past
    // it in every direction, and all four corners come back buried. Measured: 18 of 408 junctions
    // had no clear candidate at the nominal radius and lost their signs entirely.
    //
    // So the corner is a DIRECTION, not a position — the same move `toKerb` makes for a signal
    // mast. Step out along it until there is ground to stand on, and only give up when even the
    // far end of the walk is still road, which means this is not a corner at all.
    const centre = toWorld(X.x, X.y)
    let spot: { x: number; y: number } | null = null
    for (let i = 0; i < corners.length && !spot; i++) {
      const w = toWorld(corners[i].x, corners[i].y)
      const dx = w.x - centre.x
      const dz = w.z - centre.z
      const r0 = Math.hypot(dx, dz) || 1
      const ux = dx / r0
      const uz = dz / r0
      for (let r = r0; r <= r0 + T.BLADE_WALK_M; r += 1) {
        const px = centre.x + ux * r
        const pz = centre.z + uz * r
        if (edgeDistance(px, pz) >= T.BLADE_CLEAR) {
          // back in site metres, which is what the rest of this loop works in
          spot = { x: px, y: -pz }
          if (i > 0 || r > r0 + 0.001) counts.fellBack++
          break
        }
      }
    }
    if (!spot) {
      counts.noCorner++
      continue
    }
    const w = toWorld(spot.x, spot.y)
    const gy = groundAt(w.x, w.z) ?? 0
    counts.junctions++
    // a post, and the blades stacked on it, tallest name first
    const top = gy + T.BLADE_POST_H
    const r = 0.045
    const seg = 6
    const pb = postPos.length / 3
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2
      postPos.push(w.x + Math.cos(a) * r, gy, w.z + Math.sin(a) * r)
      postPos.push(w.x + Math.cos(a) * r, top + 0.05, w.z + Math.sin(a) * r)
    }
    for (let s = 0; s < seg; s++) {
      const b = pb + s * 2
      postIdx.push(b, b + 1, b + 3, b, b + 3, b + 2)
    }
    blades.forEach((bl, i) => {
      const cell = uv.get(bl.text)
      if (!cell) return
      const h = T.BLADE_H
      const wdt = Math.max(T.BLADE_H * 2.2, bl.text.length * T.BLADE_H * 0.46)
      quad(w.x, top - i * (h + 0.06) - h / 2, w.z, bl.yaw_deg, wdt, h, cell)
      counts.blades++
      if (bl.truncated) counts.truncated++
    })
  }
  if (!counts.blades) return { group, counts }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0, side: THREE.FrontSide }))
  mesh.name = 'blades:faces'
  group.add(mesh)

  const pg = new THREE.BufferGeometry()
  pg.setAttribute('position', new THREE.Float32BufferAttribute(postPos, 3))
  pg.setIndex(postIdx)
  pg.computeVertexNormals()
  pg.computeBoundingSphere()
  group.add(new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: 0x6e6e68, roughness: 0.7, metalness: 0.2 })))
  return { group, counts }
}
