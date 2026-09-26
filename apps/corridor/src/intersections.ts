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

/**
 * `roadAt(x, z)` is the ROAD SURFACE — the carriageway spline's height plus the asphalt's lift —
 * not the ground. Measured at an all-way stop on crofton-triangle (2026-09-26): the ground
 * sampler said 53.6 m where the asphalt mesh sat at 54.12, and every bar drawn at ground + 0.05
 * was buried 0.4 m under the pavement while its counts read as fine. Paint goes on the road.
 */
export function buildStopBars(
  manifest: Manifest,
  roadAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
  info: LaneInfoMap = new Map(),
): BarsResult {
  const group = new THREE.Group()
  group.name = 'stopbars'
  const counts = { bars: 0, metres: 0, clipped: 0, noRoad: 0 }
  // the bake's bars are the stop signs'; a signal's approaches get theirs here
  const bars = [...(manifest.signals?.bars ?? []), ...signalBars(manifest)]
  if (!bars.length) return { group, counts }
  const byId = new Map(((manifest.intersections?.list ?? []) as unknown as Junction[]).map((X) => [X.id, X]))

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
    // a bar spans the lanes that STOP here: the whole carriageway of a one-way road, and on a
    // two-way road only the approach's own half — the oncoming lanes have their own bar
    const appr = b.x_id != null && b.arm != null ? byId.get(b.x_id)?.approaches[b.arm] : undefined
    const lanesHere = appr ? approachLanes(appr, info) : null
    const oneway = lanesHere?.oneway ?? false
    const ownHalf = lanesHere && !oneway ? Math.min(b.width_m / 2, lanesHere.count * T.LANE_WIDTH) : b.width_m / 2
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
    // right of travel is +across: the approach's own half runs from the centre line outward
    const a0 = oneway ? Math.min(rL, b.width_m / 2) : 0
    const a1 = Math.min(rR, ownHalf)
    const hw = T.STOPBAR_DEPTH / 2
    const corners = [
      [a0, hw], [-a1, hw], [-a1, -hw], [a0, -hw],
    ] as [number, number][]
    const base = pos.length / 3
    for (const [u, v] of corners) {
      const x = p.x + across.x * u + travel.x * v
      const z = p.z + across.z * u + travel.z * v
      pos.push(x, (roadAt(x, z) ?? b.z) + T.STOPBAR_LIFT, z)
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
  // unlit and white: a lit grey on grey asphalt was invisible from above, and paint is white
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf4f4f0 }))
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
    // and a real margin: a street blade carries its legend well inside the border, about a
    // letter-height clear at each end (Rich, 2026-09-26: "need a little padding around the text")
    let px = 26
    do {
      ctx.font = `600 ${px}px "IBM Plex Sans", system-ui, sans-serif`
      if (ctx.measureText(t).width <= CELL_W - 56) break
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
    // a post, and the blades stacked ON TOP of it, the way a street sign is actually mounted: a
    // bracket on the post cap carries the plates, one above the other, at 90 degrees. They used to
    // hang from the top DOWN the post, which put the post through the middle of every legend and
    // hid the letters behind it (Rich, 2026-09-26). The post ends where the lowest blade starts.
    const top = gy + T.BLADE_POST_H
    const r = 0.045
    const seg = 6
    const pb = postPos.length / 3
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2
      postPos.push(w.x + Math.cos(a) * r, gy, w.z + Math.sin(a) * r)
      postPos.push(w.x + Math.cos(a) * r, top, w.z + Math.sin(a) * r)
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
      quad(w.x, top + i * (h + 0.04) + h / 2, w.z, bl.yaw_deg, wdt, h, cell)
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

// --- the junction, drawn with opinions --------------------------------------------------------
//
// Rich (2026-09-26): "Intersections still look like a mess — the last agent just avoided the
// issue by not drawing lines at them, but there needs to be opinions here. Stop lights and stop
// signs get a thick white cross street line before lane markings disappear. Turn lanes get dashed
// marking denoting direction of travel. Anywhere we know has a crosswalk gets a crosswalk marking."
//
// Everything below is drawn from records the bake and OSM already hold: every approach of every
// junction carries its stop-line position, width, lane count and travel bearing; OSM carries
// `turn:lanes` on the arterials and `highway=crossing` nodes. Nothing here is invented — where the
// data is silent (a residential T with no lane tags) nothing is drawn, which is also what the
// county paints there.

export interface Approach {
  road: string
  name?: string | null
  highway: string
  lanes: number
  bearing_deg: number
  sgn: number
  stop: boolean
  stop_x: number
  stop_y: number
  width_m: number
}
export interface Junction {
  id: string
  x: number
  y: number
  control: 'signals' | 'two_way_stop' | 'all_way_stop' | string
  approaches: Approach[]
}

/** Lane facts per OSM way, read from the site's osm.geojson: counts per direction and turn:lanes. */
export interface LaneInfo {
  lanes: number | null
  forward: number | null
  backward: number | null
  oneway: boolean
  turn: string[] | null
  turnForward: string[] | null
  turnBackward: string[] | null
}
export type LaneInfoMap = Map<string, LaneInfo>

const splitLanes = (v: unknown): string[] | null => (typeof v === 'string' && v.length ? v.split('|').map((s) => s.trim()) : null)
const num = (v: unknown): number | null => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n > 0 && n < 16 ? n : null }

export interface JunctionFacts {
  lanes: LaneInfoMap
  /** OSM highway=crossing nodes, WGS84; `marked` is false only for crossing=unmarked */
  crossings: { lon: number; lat: number; marked: boolean }[]
}

/** osm.geojson, keyed by the bake's road id (`r<osm id>` ↔ `way/<osm id>`), plus the crossing nodes. */
export async function loadJunctionFacts(slug: string, base = '/sites'): Promise<JunctionFacts> {
  const out: LaneInfoMap = new Map()
  const crossings: JunctionFacts['crossings'] = []
  try {
    const r = await fetch(`${base}/${slug}/osm.geojson`, { cache: 'force-cache' })
    if (!r.ok) return { lanes: out, crossings }
    const gj = (await r.json()) as { features: { id?: string; geometry: { type: string; coordinates: number[] | number[][] }; properties: Record<string, string> }[] }
    for (const f of gj.features) {
      if (f.geometry.type === 'Point' && f.properties.highway === 'crossing') {
        const [lon, lat] = f.geometry.coordinates as number[]
        crossings.push({ lon, lat, marked: f.properties.crossing !== 'unmarked' })
        continue
      }
      if (f.geometry.type !== 'LineString' || !f.id?.startsWith('way/')) continue
      const p = f.properties
      const oneway = p.oneway === 'yes' || p.oneway === '-1' || p.highway === 'motorway'
      out.set('r' + f.id.slice(4), {
        lanes: num(p.lanes), forward: num(p['lanes:forward']), backward: num(p['lanes:backward']), oneway,
        turn: splitLanes(p['turn:lanes']), turnForward: splitLanes(p['turn:lanes:forward']), turnBackward: splitLanes(p['turn:lanes:backward']),
      })
    }
  } catch {
    /* no osm layer: nothing lane-level to draw */
  }
  return { lanes: out, crossings }
}

/** The lanes of one approach in its own direction, leftmost first, with each lane's movements. */
export function approachLanes(a: Approach, info: LaneInfoMap): { count: number; turns: string[][] | null; oneway: boolean } {
  const li = info.get(a.road)
  const oneway = li?.oneway ?? false
  const turnTags = li ? (oneway ? li.turn : a.sgn > 0 ? (li.turnForward ?? null) : (li.turnBackward ?? null)) : null
  let count: number | null = turnTags ? turnTags.length : null
  if (!count && li) count = oneway ? li.lanes : a.sgn > 0 ? li.forward : li.backward
  if (!count) count = oneway ? Math.max(1, a.lanes) : Math.max(1, Math.ceil(a.lanes / 2))
  const turns = turnTags ? turnTags.map((t) => t.split(';').map((m) => m.trim()).filter((m) => m && m !== 'none')) : null
  return { count, turns, oneway }
}

/** unit travel vector (world) for a compass bearing, and its right-hand normal */
function frameOf(bearingDeg: number) {
  const th = (bearingDeg * Math.PI) / 180
  const travel = new THREE.Vector3(Math.sin(th), 0, -Math.cos(th))
  const right = new THREE.Vector3(-travel.z, 0, travel.x)
  return { travel, right }
}

/**
 * Stop lines for every approach of every SIGNALISED junction. The bake's `signals.bars` are the
 * stop-sign bars only (522 on crofton-triangle, one per sign); a signal's approaches had none,
 * which is exactly the "lane markings just disappear" Rich saw at the lights.
 */
export function signalBars(manifest: Manifest): { x: number; y: number; z: number; travel_deg: number; width_m: number; x_id: string; arm: number }[] {
  const out: ReturnType<typeof signalBars> = []
  const list = ((manifest.intersections?.list ?? []) as unknown as Junction[])
  for (const X of list) {
    if (X.control !== 'signals') continue
    X.approaches.forEach((a, i) => {
      out.push({ x: a.stop_x, y: a.stop_y, z: 0, travel_deg: a.bearing_deg, width_m: a.width_m, x_id: X.id, arm: i })
    })
  }
  return out
}

export interface CrosswalksResult {
  group: THREE.Group
  counts: { atSignals: number; atNodes: number; skippedNoWalk: number; skippedNoRoad: number }
}

/**
 * Ladder crosswalks: across every arm of a signalised junction that has a sidewalk to arrive
 * from, and at every OSM `highway=crossing` node that is not `unmarked`. MUTCD ladder: 0.4 m bars
 * on 0.6 m gaps, 2.4 m deep, the near edge 1.2 m past the stop line toward the junction.
 */
export function buildCrosswalks(
  manifest: Manifest,
  roadAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
  onSidewalk: (x: number, z: number) => boolean,
  crossingNodes: { x: number; y: number; marked: boolean }[],
): CrosswalksResult {
  const group = new THREE.Group()
  group.name = 'crosswalks'
  const counts = { atSignals: 0, atNodes: 0, skippedNoWalk: 0, skippedNoRoad: 0 }
  const pos: number[] = []
  const idx: number[] = []
  const placed: THREE.Vector3[] = []
  const DEPTH = 2.4, BAR = 0.4, GAP = 0.6

  /** walk out from `p` along ±across until the asphalt ends; the ladder spans what it finds */
  const reach = (p: THREE.Vector3, across: THREE.Vector3, sgn: number, max: number) => {
    let d = 0
    for (let k = 0.25; k <= max; k += 0.25) {
      if (edgeDistance(p.x + across.x * k * sgn, p.z + across.z * k * sgn) >= 0) break
      d = k
    }
    return d
  }
  const ladder = (centre: THREE.Vector3, travel: THREE.Vector3, halfMax: number, needWalk: boolean): boolean => {
    const across = new THREE.Vector3(-travel.z, 0, travel.x)
    const rL = reach(centre, across, -1, halfMax + 3), rR = reach(centre, across, 1, halfMax + 3)
    if (rL + rR < 3) { counts.skippedNoRoad++; return false }
    if (needWalk) {
      // a crossing goes somewhere: a sidewalk within a few metres of either kerb
      let walk = false
      for (const [sgn, r] of [[-1, rL], [1, rR]] as [number, number][]) for (let k = 0.5; k <= 5 && !walk; k += 0.5) {
        if (onSidewalk(centre.x + across.x * (r + k) * sgn, centre.z + across.z * (r + k) * sgn)) walk = true
      }
      if (!walk) { counts.skippedNoWalk++; return false }
    }
    for (let u = -rL + GAP / 2; u + BAR <= rR; u += BAR + GAP) {
      const c0 = u, c1 = u + BAR
      const base = pos.length / 3
      for (const [cu, cv] of [[c0, -DEPTH / 2], [c1, -DEPTH / 2], [c1, DEPTH / 2], [c0, DEPTH / 2]] as [number, number][]) {
        const x = centre.x + across.x * cu + travel.x * cv
        const z = centre.z + across.z * cu + travel.z * cv
        pos.push(x, (roadAt(x, z) ?? centre.y) + T.STOPBAR_LIFT + 0.005, z)
      }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
    placed.push(centre.clone())
    return true
  }

  const list = ((manifest.intersections?.list ?? []) as unknown as Junction[])
  for (const X of list) {
    if (X.control !== 'signals') continue
    for (const a of X.approaches) {
      const { travel } = frameOf(a.bearing_deg)
      const stop = toWorld(a.stop_x, a.stop_y)
      // between the stop line and the box: 1.2 m clear, then the 2.4 m ladder
      const centre = stop.clone().add(travel.clone().multiplyScalar(1.2 + DEPTH / 2))
      centre.y = roadAt(centre.x, centre.z) ?? 0
      if (ladder(centre, travel, a.width_m / 2, true)) counts.atSignals++
    }
  }
  // OSM crossing nodes not already covered by a signal's ladder: the direction comes from the
  // nearest branch segment, because a node has no bearing of its own
  const branches = ((manifest as unknown as { branches?: { coords: number[][] }[] }).branches ?? [])
  for (const n of crossingNodes) {
    if (!n.marked) continue
    const w = toWorld(n.x, n.y)
    if (placed.some((p) => p.distanceTo(w) < 10)) continue
    let best = Infinity, dir: THREE.Vector3 | null = null
    for (const b of branches) {
      const c = b.coords
      for (let k = 1; k < c.length; k++) {
        const ax = c[k - 1][0], ay = c[k - 1][1], bx = c[k][0], by = c[k][1]
        const dx = bx - ax, dy = by - ay
        const l2 = dx * dx + dy * dy || 1
        const t = Math.max(0, Math.min(1, ((n.x - ax) * dx + (n.y - ay) * dy) / l2))
        const d = Math.hypot(ax + t * dx - n.x, ay + t * dy - n.y)
        if (d < best) { best = d; dir = new THREE.Vector3(dx, 0, -dy).normalize() }
      }
    }
    if (!dir || best > 15) { counts.skippedNoRoad++; continue }
    w.y = roadAt(w.x, w.z) ?? 0
    if (ladder(w, dir, 12, false)) counts.atNodes++
  }
  if (idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf4f4f0 }))
    mesh.name = 'crosswalks:paint'
    group.add(mesh)
  }
  return { group, counts }
}

export interface ArrowsResult {
  group: THREE.Group
  counts: { approaches: number; arrows: number; lanesTagged: number }
}

/**
 * Lane-use arrows from `turn:lanes`, two per lane in the last twenty metres before the stop line:
 * a straight arrow for through, a hooked one for left or right, both on a lane that allows both.
 * Lanes are listed left to right in OSM; for right-hand traffic lane 0 sits against the centre
 * line on a two-way road and against the left edge on a one-way carriageway.
 */
export function buildLaneArrows(manifest: Manifest, roadAt: (x: number, z: number) => number | null, info: LaneInfoMap): ArrowsResult {
  const group = new THREE.Group()
  group.name = 'lanearrows'
  const counts = { approaches: 0, arrows: 0, lanesTagged: 0 }
  const pos: number[] = []
  const idx: number[] = []
  const LW = T.LANE_WIDTH
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const k = pos.length / 3
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
    idx.push(k, k + 1, k + 2)
  }
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => { tri(a, b, c); tri(a, c, d) }
  /** one arrow at `origin` (the lane centre, arrow base), travel/right frame; movements decide the heads */
  const arrow = (origin: THREE.Vector3, travel: THREE.Vector3, right: THREE.Vector3, moves: string[]) => {
    const P = (s: number, r: number) => { const x = origin.x + travel.x * s + right.x * r, z = origin.z + travel.z * s + right.z * r; return new THREE.Vector3(x, (roadAt(x, z) ?? origin.y) + T.STOPBAR_LIFT + 0.01, z) }
    const through = moves.some((m) => m === 'through' || m === 'slight_left' || m === 'slight_right' || m === 'merge_to_left' || m === 'merge_to_right')
    const left = moves.some((m) => m === 'left' || m === 'sharp_left')
    const rightT = moves.some((m) => m === 'right' || m === 'sharp_right')
    if (!through && !left && !rightT) return false
    // the shaft, 2.4 m; a through head on top; a side head off the shaft's top for each turn
    quad(P(0, -0.15), P(0, 0.15), P(2.4, 0.15), P(2.4, -0.15))
    if (through) tri(P(2.4, -0.6), P(2.4, 0.6), P(3.6, 0))
    for (const [on, sgn] of [[left, -1], [rightT, 1]] as [boolean, number][]) {
      if (!on) continue
      quad(P(1.7, 0), P(2.0, 0), P(2.0, sgn * 0.9), P(1.7, sgn * 0.9))
      tri(P(1.3, sgn * 0.9), P(2.4, sgn * 0.9), P(1.85, sgn * 1.7))
    }
    counts.arrows++
    return true
  }
  const list = ((manifest.intersections?.list ?? []) as unknown as Junction[])
  for (const X of list) {
    for (const a of X.approaches) {
      const { count, turns, oneway } = approachLanes(a, info)
      if (!turns) continue
      counts.approaches++
      const { travel, right } = frameOf(a.bearing_deg)
      const stop = toWorld(a.stop_x, a.stop_y)
      stop.y = roadAt(stop.x, stop.z) ?? 0
      turns.forEach((moves, j) => {
        if (!moves.length) return
        counts.lanesTagged++
        // lane centre, right of the road's centre line (two-way) or of the carriageway's centre
        const rOff = oneway ? (j + 0.5) * LW - (count * LW) / 2 : (j + 0.5) * LW
        for (const back of [6, 18]) {
          const origin = stop.clone().add(travel.clone().multiplyScalar(-back - 3.6)).add(right.clone().multiplyScalar(rOff))
          arrow(origin, travel, right, moves)
        }
      })
    }
  }
  if (idx.length) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setIndex(idx)
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf4f4f0 }))
    mesh.name = 'lanearrows:paint'
    group.add(mesh)
  }
  return { group, counts }
}

/**
 * The paint cut at a junction, per ARM: a marking is off when it lies between a junction's centre
 * and that arm's stop line. Replaces a circle of JUNCTION_CLEAR, which cut every arm at the same
 * radius whatever its stop line said and left a bare disc with lines stopping short of it.
 */
export function junctionPaintCut(manifest: Manifest): (x: number, z: number) => boolean {
  const list = ((manifest.intersections?.list ?? []) as unknown as Junction[])
  const J = list.map((X) => {
    const c = toWorld(X.x, X.y)
    const arms = X.approaches.map((a) => {
      const s = toWorld(a.stop_x, a.stop_y)
      const dx = s.x - c.x, dz = s.z - c.z
      const d = Math.hypot(dx, dz) || 1
      return { ox: dx / d, oz: dz / d, stop: d + 0.3 }
    })
    const R = Math.max(1, ...arms.map((a) => a.stop)) + 2
    return { x: c.x, z: c.z, R2: R * R, arms }
  })
  const cell = 200
  const grid = new Map<string, typeof J>()
  for (const j of J) {
    const r = Math.sqrt(j.R2)
    for (let gx = Math.floor((j.x - r) / cell); gx <= Math.floor((j.x + r) / cell); gx++) for (let gz = Math.floor((j.z - r) / cell); gz <= Math.floor((j.z + r) / cell); gz++) {
      const k = `${gx},${gz}`
      const arr = grid.get(k)
      if (arr) arr.push(j)
      else grid.set(k, [j])
    }
  }
  return (x, z) => {
    const arr = grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`)
    if (!arr) return false
    for (const j of arr) {
      const dx = x - j.x, dz = z - j.z
      const d2 = dx * dx + dz * dz
      if (d2 > j.R2) continue
      const d = Math.sqrt(d2) || 1e-6
      let best = -2, stop = 0
      for (const a of j.arms) {
        const dot = (dx * a.ox + dz * a.oz) / d
        if (dot > best) { best = dot; stop = a.stop }
      }
      if (d < stop) return true
    }
    return false
  }
}
