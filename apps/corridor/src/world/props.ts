// Stand-ins: the things the game will eventually place for real, drawn here at the right SIZE
// and in the right PLACE so a ground-level view reads correctly before any TRELLIS asset exists.
//
//   road    an asphalt ribbon as wide as OSM's lane count says, with edge lines and lane dashes
//   trees   one instanced lollipop per canopy cell, as tall as the lidar canopy there
//   piers   an overpass deck resting on two piers that reach the measured ground
//
// Everything is in the viewer's world frame (X east, Y up, Z south) and sized in metres, so
// swapping a stand-in for a generated glb later is a one-line change per prop kind.
import * as THREE from 'three'
import type { Budget } from './budget'
import { injectFloodLamp, paintMaterial, retro } from '../visuals/retro'
import { HEX_GLSL } from '../visuals/hextile'
import type { TreeRecord } from './trees'

import * as T from '../tuning'
import { installRoadClip } from '../visuals/roadcover'
import { chainCompile, injectRelief, injectShade, injectWetStreak } from '../visuals/shading'

// road cross-section: knobs in tuning.ts (F6 → road); a change needs a site reload to rebuild
/** @deprecated read T.LANE_WIDTH live — a knob changes it */
export const LANE_M = T.LANE_WIDTH
/** @deprecated read T.SHOULDER_OUT live — a knob changes it */
export const SHOULDER_OUT_M = T.SHOULDER_OUT
/** @deprecated read T.SHOULDER_IN live — a knob changes it */
export const SHOULDER_IN_M = T.SHOULDER_IN

export interface Station {
  pos: THREE.Vector3 // road surface centreline
  dir: THREE.Vector3 // unit, horizontal
  s: number
}

const UP = new THREE.Vector3(0, 1, 0)

/** Dense stations along a spineAt() function, every `step` metres. */
export function stations(spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }, length: number, step = 6): Station[] {
  const out: Station[] = []
  for (let s = 0; s <= length; s += step) {
    const p = spineAt(s)
    out.push({ pos: p.pos, dir: p.dir.clone().setY(0).normalize(), s })
  }
  return out
}

/**
 * Lane counts come out of OSM as a step function: `lanes=3` for 550 m, then `lanes=4` for 200 m with
 * `turn:lanes=|||merge_to_left`, then `lanes=3` again. Drawn literally that is a lane that appears
 * and disappears in one 6 m quad — a road that grows a lane sideways. Real ones taper: an auxiliary
 * lane between two interchanges opens and closes over a few tens of metres, and the edge line
 * converges across it.
 *
 * This wraps a step `lanesAt` into a ramped one, so a lane count is fractional inside a taper and the
 * paved width, the edge line and the shoulder all converge together. Tapers shrink where two changes
 * are closer than `taper` apart, so a short auxiliary lane still opens and closes cleanly.
 *
 * Sampled onto a dense array once and read by interpolation, because `edgeDistance` calls this for
 * every grass blade and every car tick.
 */
function taperSamples(lanesAt: (s: number) => number, s0: number, n: number, step: number, taper: number): Float32Array {
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = lanesAt(s0 + i * step)
  const out = Float32Array.from(raw)
  if (taper > 0) {
    const changes: { s: number; from: number; to: number }[] = []
    for (let i = 1; i < n; i++) if (raw[i] !== raw[i - 1]) changes.push({ s: (i - 0.5) * step, from: raw[i - 1], to: raw[i] })
    changes.forEach((c, i) => {
      const prevGap = i > 0 ? (c.s - changes[i - 1].s) / 2 : Infinity
      const nextGap = i < changes.length - 1 ? (changes[i + 1].s - c.s) / 2 : Infinity
      const h = Math.min(taper / 2, prevGap, nextGap)
      if (!(h > 0)) return
      const i0 = Math.max(0, Math.floor((c.s - h) / step)), i1 = Math.min(n - 1, Math.ceil((c.s + h) / step))
      for (let k = i0; k <= i1; k++) {
        const t = Math.min(1, Math.max(0, (k * step - (c.s - h)) / (2 * h)))
        out[k] = c.from + (c.to - c.from) * t
      }
    })
  }
  return out
}

export function taperedLanes(lanesAt: (s: number) => number, length: number, taper = T.ROAD_TAPER_M, step = 2): (s: number) => number {
  // A coast-to-coast spine sampled every 2 m is millions of lanes. The ramp at s only depends on
  // lane changes within `taper` of s, so a long road samples that window when it is asked.
  // STREAM_LOCAL = 0 keeps the full table, which is what a short road still gets either way.
  if (T.STREAM_LOCAL > 0 && length > 80_000) {
    const span = Math.max(step, taper)
    return (s) => {
      const s0 = Math.max(0, s - span)
      const s1 = Math.min(length, s + span)
      const n = Math.max(2, Math.ceil((s1 - s0) / step) + 1)
      const out = taperSamples(lanesAt, s0, n, step, taper)
      const x = Math.min(n - 1, Math.max(0, (s - s0) / step))
      const i = Math.floor(x), f = x - i
      return out[i] * (1 - f) + out[Math.min(n - 1, i + 1)] * f
    }
  }
  const n = Math.max(2, Math.ceil(length / step) + 1)
  const out = taperSamples(lanesAt, 0, n, step, taper)
  return (s) => {
    const x = Math.min(n - 1, Math.max(0, s / step))
    const i = Math.floor(x), f = x - i
    return out[i] * (1 - f) + out[Math.min(n - 1, i + 1)] * f
  }
}

/** Width of the paved surface at station s: lanes × 3.66 + both shoulders. */
/**
 * Road classes that are KERBED in an American suburb: the asphalt ends at a gutter a few hundred
 * millimetres past the lane, there is no shoulder and no edge line, and a stop line runs from
 * the centre line to the kerb. Everything else (arterials, links, motorways) carries shoulders
 * and edge lines. Rich, at an all-way stop in Crofton: "the line not spanning the lane" — the
 * residential street was modelled with a 3 m shoulder and its edge line 2.5 m from the centre,
 * so the bar crossed the edge line onto asphalt that is not there.
 */
export const KERBED = new Set(['residential', 'living_street', 'unclassified', 'service', 'tertiary', 'tertiary_link'])
export const isKerbed = (highway: string | undefined | null) => KERBED.has(highway ?? '')

export function pavedWidth(lanes: number, twoWay = false, kerbed = false): number {
  if (kerbed) return lanes * T.LANE_WIDTH + 2 * T.KERB_GUTTER
  return lanes * T.LANE_WIDTH + T.SHOULDER_OUT + (twoWay ? T.SHOULDER_OUT : T.SHOULDER_IN)
}

/**
 * How far right of the spine the asphalt's centre sits.
 *
 * A one-way carriageway is not symmetric: it carries a wide outside shoulder and a narrow median
 * one, so the middle of the asphalt is (SHOULDER_OUT − SHOULDER_IN)/2 = 0.9 m right of the middle of
 * the travel lanes. OSM's motorway way is drawn down the TRAVEL LANES, not down the asphalt, so
 * centring the asphalt on the spine puts every lane 0.9 m too far left. Offsetting it puts the lanes
 * where OSM says they are and the shoulders where they belong.
 *
 * `ROAD_ONEWAY_CENTRE` = 0 anchors the lanes on the spine (the truthful one, default); 1 restores
 * the old symmetric asphalt. Two-way roads have equal shoulders, so their offset is always 0.
 */
export function pavedOffset(twoWay = false, kerbed = false): number {
  if (twoWay || kerbed || T.ROAD_ONEWAY_CENTRE >= 0.5) return 0
  return (T.SHOULDER_OUT - T.SHOULDER_IN) / 2
}

/**
 * The road as the game would draw it: a ribbon of asphalt, a yellow line on the left edge (US
 * divided highway), white on the right, white dashes between lanes. `lanesAt(s)` comes from the
 * spine's OSM segments; siblings without tags get 2.
 */
export interface SurfaceSet {
  name: string
  material: THREE.Material
  metresPerTile: number
  /** the hex-tiling inputs, kept so two sets can be mixed in one shader (see blendMaterial) */
  hex?: {
    albedo: THREE.DataArrayTexture
    normal: THREE.DataArrayTexture
    layers: number
    macro: THREE.Texture | null
    macroMetres: number
  }
}

/**
 * A material that hex-tiles TWO surface sets and mixes them along a `blend` vertex attribute.
 *
 * Where the surface class changes the pavement used to change in one edge — a paving joint with a
 * ruler's edge, which is what a resurfacing joint never looks like. The transition strip is its own
 * geometry sitting in the gap left by trimming the two neighbouring quads back, so the two
 * materials never overlap and there is nothing to z-fight; the mix happens in the shader.
 *
 * `hextile.ts` is world-look's file, so rather than reshape `hexSample` to take its samplers as
 * parameters, this declares a second set of uniforms and a `hexSampleB` that reuses HEX_GLSL's own
 * `hexTriangleGrid` and `hexHash`. If that file ever grows a parameterised sampler, delete this.
 *
 * UVs on the blend geometry are in METRES (u across the road, v along it) and divided by each set's
 * metresPerTile here, because the two sets tile at different scales.
 */
export function blendMaterial(a: SurfaceSet, b: SurfaceSet): THREE.Material | null {
  if (!a.hex || !b.hex) return null
  const base = a.material as THREE.MeshStandardMaterial
  const mat = new THREE.MeshStandardMaterial({ map: base.map, normalMap: base.normalMap, normalScale: new THREE.Vector2(1.25, 1.25), roughnessMap: base.roughnessMap, roughness: 1, metalness: 0, side: THREE.DoubleSide })
  const A = a.hex, B = b.hex
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.hexAlbedo = { value: A.albedo }
    shader.uniforms.hexNormal = { value: A.normal }
    shader.uniforms.hexLayers = { value: A.layers }
    shader.uniforms.hexCell = { value: 1.6 }
    shader.uniforms.hexAlbedoB = { value: B.albedo }
    shader.uniforms.hexNormalB = { value: B.normal }
    shader.uniforms.hexLayersB = { value: B.layers }
    shader.uniforms.macroA = { value: A.macro }
    shader.uniforms.macroB = { value: B.macro }
    shader.uniforms.useMacroA = { value: A.macro ? 1 : 0 }
    shader.uniforms.useMacroB = { value: B.macro ? 1 : 0 }
    shader.uniforms.mptA = { value: a.metresPerTile }
    shader.uniforms.mptB = { value: b.metresPerTile }
    shader.uniforms.macroMetresA = { value: A.macroMetres }
    shader.uniforms.macroMetresB = { value: B.macroMetres }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float blend;\nvarying float vBlend;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlend = blend;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_pars_fragment>',
        `#include <map_pars_fragment>
${HEX_GLSL}
uniform sampler2DArray hexAlbedoB;
uniform sampler2DArray hexNormalB;
uniform float hexLayersB;
uniform sampler2D macroA;
uniform sampler2D macroB;
uniform int useMacroA;
uniform int useMacroB;
uniform float mptA;
uniform float mptB;
uniform float macroMetresA;
uniform float macroMetresB;
varying float vBlend;
vec3 hexN = vec3(0.0, 0.0, 1.0);

vec4 hexSampleB(vec2 uv, out vec3 n) {
  float w1, w2, w3; ivec2 v1, v2, v3;
  hexTriangleGrid(uv / hexCell, w1, w2, w3, v1, v2, v3);
  vec3 h1 = hexHash(v1), h2 = hexHash(v2), h3 = hexHash(v3);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 uv1 = vec3(uv + h1.xy, floor(h1.z * hexLayersB));
  vec3 uv2 = vec3(uv + h2.xy, floor(h2.z * hexLayersB));
  vec3 uv3 = vec3(uv + h3.xy, floor(h3.z * hexLayersB));
  vec3 w = pow(vec3(w1, w2, w3), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec4 c = textureGrad(hexAlbedoB, uv1, dx, dy) * w.x + textureGrad(hexAlbedoB, uv2, dx, dy) * w.y + textureGrad(hexAlbedoB, uv3, dx, dy) * w.z;
  vec3 nn = textureGrad(hexNormalB, uv1, dx, dy).xyz * w.x + textureGrad(hexNormalB, uv2, dx, dy).xyz * w.y + textureGrad(hexNormalB, uv3, dx, dy).xyz * w.z;
  n = nn * 2.0 - 1.0;
  return vec4(c.rgb, 1.0);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `
        #ifdef USE_MAP
          vec3 nA, nB;
          vec4 cA = hexSample(vMapUv / mptA, nA);
          vec4 cB = hexSampleB(vMapUv / mptB, nB);
          if (useMacroA == 1) cA.rgb *= mix(vec3(1.0), texture2D(macroA, vMapUv / macroMetresA).rgb * 2.0, 0.85);
          if (useMacroB == 1) cB.rgb *= mix(vec3(1.0), texture2D(macroB, vMapUv / macroMetresB).rgb * 2.0, 0.85);
          float t = smoothstep(0.0, 1.0, clamp(vBlend, 0.0, 1.0));
          hexN = normalize(mix(nA, nB, t));
          diffuseColor *= mix(cA, cB, t);
        #endif
        `,
      )
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = hexN;'))
  }
  mat.customProgramCacheKey = () => `road-blend-${a.name}>${b.name}`
  chainCompile(mat, (shader) => {
    injectRelief(shader)
    injectShade(shader)
    injectWetStreak(shader)
    injectFloodLamp(shader)
  }, 'relief-shade-wet-vert')
  return mat
}

const blendCache = new Map<string, THREE.Material | null>()
function blendFor(sets: Record<string, SurfaceSet>, from: string, to: string): THREE.Material | null {
  const k = `${from}>${to}`
  if (!blendCache.has(k)) blendCache.set(k, sets[from] && sets[to] ? blendMaterial(sets[from], sets[to]) : null)
  return blendCache.get(k) ?? null
}

/**
 * Paint scheme from OSM: a one-way carriageway (a divided highway's lanes, `oneway=yes` or a
 * motorway) has a yellow line on its left edge and white on the right, with white dashes between
 * lanes. A two-way road (`oneway=no`, or a non-motorway with no tag) has a DOUBLE YELLOW down the
 * centre and white edge lines both sides; its lanes are split evenly about the centreline.
 */
/**
 * Build a carriageway: asphalt, then its markings.
 *
 * `paintOff(x, z)` is how a junction stays bare. Nothing is painted through an intersection in
 * the real world — no double yellow crossing another double yellow, no edge line ruled across the
 * mouth of a side road — and we were painting every line straight through every one of them
 * (Rich, twice). The predicate is asked for each marking quad at its own lateral offset, so a
 * junction on the right erases the right-hand edge line and leaves the left one alone.
 */
/**
 * `skipAt` LEAVES A HOLE IN THE ROAD, by station.
 *
 * Rich, 2026-09-29, on stunt fixtures: *"don't render the openstreet map road underneath the
 * stunt"*. A loop IS the road where it stands, so drawing both gives you a vertical circle with a
 * strip of tarmac through the middle of it. Answering per QUAD rather than per vertex matters: a
 * quad is trimmed at a class boundary and blended across it, so a vertex-level skip would leave
 * half-quads and torn blend bands at the edge of every fixture.
 */
function* roadMeshGen(st: Station[], lanesAt: (s: number) => number, classAt: (s: number) => string = () => 'asphalt_aged', sets: Record<string, SurfaceSet> = {}, lift = 0.02, twoWayAt: (s: number) => boolean = () => false, paintOff: ((x: number, z: number) => boolean) | null = null, kerbedAt: (s: number) => boolean = () => false, skipAt: ((s: number) => boolean) | null = null): Generator<void, THREE.Group, void> {
  const g = new THREE.Group()
  // one asphalt geometry per surface class, so each gets its own textured material
  const byClass: Record<string, { pos: number[]; uv: number[]; idx: number[] }> = {}
  const bucket = (cls: string) => (byClass[cls] ??= { pos: [], uv: [], idx: [] })
  const marks: number[] = []
  const mcol: number[] = []
  const midx: number[] = []
  const white = [0.92, 0.92, 0.9]
  const yellow = [0.95, 0.78, 0.1]

  const quad = (pos: number[], idx: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col?: number[], cols?: number[], uv?: number[], uvs?: number[]) => {
    const k = pos.length / 3
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z)
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2) // counter-clockwise from above: the face points up
    if (col && cols) for (let i = 0; i < 4; i++) cols.push(...col)
    if (uv && uvs) uvs.push(...uv)
  }

  // Class per quad, so a quad knows whether either of its ends is a class boundary. The blend band
  // is a strip of its own geometry in the gap left by trimming both neighbours back by half a band;
  // no quad overlaps another, so there is nothing to z-fight.
  const quadClass: string[] = []
  for (let i = 0; i < st.length - 1; i++) quadClass.push(classAt((st[i].s + st[i + 1].s) / 2))
  const blends: Record<string, { pos: number[]; uv: number[]; idx: number[]; bl: number[] }> = {}
  const lerpSt = (a: Station, b: Station, t: number): Station => ({
    pos: a.pos.clone().lerp(b.pos, t),
    dir: a.dir.clone().lerp(b.dir, t).normalize(),
    s: a.s + (b.s - a.s) * t,
  })

  for (let i = 0; i < st.length - 1; i++) {
    const a0 = st[i], b0 = st[i + 1]
    // A stunt fixture stands here and IS the road: drawing the baked tarmac as well puts a strip
    // through the middle of a loop. Tested at the quad's midpoint, so a fixture takes whole quads.
    if (skipAt && skipAt((a0.s + b0.s) / 2)) continue
    // half a band, but never more than 40% of the quad, so a short station interval stays sane
    const half = Math.min(T.ROAD_BLEND_M / 2, (b0.s - a0.s) * 0.4)
    const cutStart = i > 0 && quadClass[i - 1] !== quadClass[i] ? half : 0
    const cutEnd = i < quadClass.length - 1 && quadClass[i + 1] !== quadClass[i] ? half : 0
    const span = b0.s - a0.s || 1
    const a = cutStart > 0 ? lerpSt(a0, b0, cutStart / span) : a0
    const b = cutEnd > 0 ? lerpSt(a0, b0, 1 - cutEnd / span) : b0
    const la = lanesAt(a.s), lb = lanesAt(b.s)
    // ROOT CAUSE of "lanes ~35% too narrow on the 2-lane road" (Rich, 2026-09-21): this called
    // pavedWidth(lanes) without the two-way flag, so a two-way road got one inside shoulder
    // (1.2 m) instead of two outside ones (3.0 m) — 11.5 m of asphalt instead of 13.3 — and the
    // edge lines, drawn SHOULDER_OUT in from that edge, sat 2.76 m from the centre: a 2.76 m lane
    // where 3.66 was meant (0.75×). The paved-edge lookup in scene.ts already used the flag, so
    // the strip and the asphalt disagreed by 0.9 m a side as well.
    const twoWay = twoWayAt((a.s + b.s) / 2)
    const kerbed = kerbedAt((a.s + b.s) / 2)
    const wa = pavedWidth(la, twoWay, kerbed), wb = pavedWidth(lb, twoWay, kerbed)
    // the asphalt's centre, right of the spine: 0 for a two-way road, half the shoulder difference
    // for a carriageway (see pavedOffset)
    const off = pavedOffset(twoWay, kerbed)
    const sa = a.dir.clone().cross(UP), sb = b.dir.clone().cross(UP) // right of travel
    const ya = a.pos.y + lift, yb = b.pos.y + lift
    const P = (base: THREE.Vector3, side: THREE.Vector3, off: number, y: number) => new THREE.Vector3(base.x + side.x * off, y, base.z + side.z * off)
    // asphalt, edge to edge (left shoulder edge is -w/2 + (SHOULDER_IN - SHOULDER_OUT)/2, but the
    // centreline of a carriageway in OSM is drawn mid-pavement; keep it symmetric)
    const cls = classAt((a.s + b.s) / 2)
    const bk = bucket(cls)
    const mpt = sets[cls]?.metresPerTile ?? 1
    // UVs in metres over the tile size: u across the pavement, v along the road, so the texture
    // repeats at its real scale and lane dashes stay where paint would be
    quad(bk.pos, bk.idx, P(a.pos, sa, off - wa / 2, ya), P(a.pos, sa, off + wa / 2, ya), P(b.pos, sb, off - wb / 2, yb), P(b.pos, sb, off + wb / 2, yb), undefined, undefined,
      [0, a.s / mpt, wa / mpt, a.s / mpt, 0, b.s / mpt, wb / mpt, b.s / mpt], bk.uv)
    // Paint runs over the untrimmed station interval: it sits 0.04 m above the asphalt, so it
    // crosses the blend band without a gap and without fighting it. Widths are MUTCD's: normal
    // lines 150 mm (edge, lane), the double yellow two 100 mm lines 100 mm apart.
    const ml = 0.075
    /**
     * One marking from station `from` to station `to`, at lateral offsets o0 → o1, CLIPPED where
     * it enters a junction. The first version dropped any quad whose either end was inside, so
     * every line stopped up to a whole station (6 m) short of the stop bar — Rich: "lines didn't
     * intersect at stop lines. That was a big tell." Now the boundary is found by bisection on
     * the predicate (seven steps, 5 cm on a 6 m quad) and the quad ends exactly there.
     */
    const paintSeg = (o0: number, o1: number, half: number, col: number[], from: Station = a, to: Station = b) => {
      const at = (t: number) => {
        const s = t <= 0 ? from : t >= 1 ? to : lerpSt(from, to, t)
        const sd = s.dir.clone().cross(UP)
        const o = o0 + (o1 - o0) * t
        return { s, sd, o }
      }
      let t0 = 0, t1 = 1
      if (paintOff) {
        const inside = (t: number) => { const q = at(t); return paintOff(q.s.pos.x + q.sd.x * q.o, q.s.pos.z + q.sd.z * q.o) }
        const i0 = inside(0), i1 = inside(1)
        if (i0 && i1) return
        if (i0) { let lo = 0, hi = 1; for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (inside(m)) lo = m; else hi = m } t0 = hi }
        if (i1) { let lo = 0, hi = 1; for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m } t1 = lo }
        if (t1 - t0 < 0.02) return
      }
      const A = at(t0), B = at(t1)
      const yA = A.s.pos.y + lift + 0.02, yB = B.s.pos.y + lift + 0.02
      quad(marks, midx, P(A.s.pos, A.sd, A.o - half, yA), P(A.s.pos, A.sd, A.o + half, yA), P(B.s.pos, B.sd, B.o - half, yB), P(B.s.pos, B.sd, B.o + half, yB), col, mcol)
    }
    const cycle = Math.floor(a0.s / 12) * 12
    const dash = a0.s - cycle < 3.01 && Math.round(la) === Math.round(lb)
    const dashLen = Math.min(3, b0.s - a0.s)
    const dashEnd: Station = { pos: a0.pos.clone().add(a0.dir.clone().multiplyScalar(dashLen)), dir: a0.dir, s: a0.s + dashLen }
    if (twoWay) {
      // two-way: white edge lines on both shoulders, double yellow at the centre, white dashes
      // between the lanes of each direction (3+ lanes a side)
      // a kerbed street has no edge line; an arterial's sits SHOULDER_OUT in from the edge
      if (!kerbed) {
        const edgeA = wa / 2 - T.SHOULDER_OUT + off, edgeB = wb / 2 - T.SHOULDER_OUT + off
        for (const sgn of [-1, 1]) paintSeg(sgn * edgeA, sgn * edgeB, ml, white)
      }
      for (const off of [-0.1, 0.1]) paintSeg(off, off, 0.05, yellow)
      const perSide = Math.max(1, Math.floor(la / 2))
      if (dash) for (const sgn of [-1, 1]) for (let l = 1; l < perSide; l++) paintSeg(sgn * l * T.LANE_WIDTH, sgn * l * T.LANE_WIDTH, ml, white, a0, dashEnd)
    } else {
      // one-way carriageway: yellow left (median side), white right, on the shoulder boundaries
      const leftA = -wa / 2 + T.SHOULDER_IN + off, leftB = -wb / 2 + T.SHOULDER_IN + off
      const rightA = wa / 2 - T.SHOULDER_OUT + off, rightB = wb / 2 - T.SHOULDER_OUT + off
      paintSeg(leftA, leftB, ml, yellow)
      paintSeg(rightA, rightB, ml, white)
      // lane dashes: 3 m paint / 9 m gap is the US standard; one dash per 12 m station cycle
      if (dash) for (let l = 1; l < la; l++) paintSeg(leftA + l * T.LANE_WIDTH, leftA + l * T.LANE_WIDTH, ml, white, a0, dashEnd)
    }

    // the transition strip into the gap this quad's trimmed end left
    if (cutEnd > 0 && T.ROAD_BLEND_M > 0) {
      const from = quadClass[i], to = quadClass[i + 1]
      const key = `${from}>${to}`
      const bk2 = (blends[key] ??= { pos: [], uv: [], idx: [], bl: [] })
      const n0 = lerpSt(a0, b0, 1 - cutEnd / span) // = b
      const nextSpan = st[i + 2] ? st[i + 2].s - b0.s || 1 : span
      const n1 = st[i + 2] ? lerpSt(b0, st[i + 2], Math.min(T.ROAD_BLEND_M / 2, nextSpan * 0.4) / nextSpan) : b0
      const w0 = pavedWidth(lanesAt(n0.s), twoWayAt(n0.s), kerbedAt(n0.s)), w1 = pavedWidth(lanesAt(n1.s), twoWayAt(n1.s), kerbedAt(n1.s))
      const s0 = n0.dir.clone().cross(UP), s1 = n1.dir.clone().cross(UP)
      const y0 = n0.pos.y + lift, y1 = n1.pos.y + lift
      const k = bk2.pos.length / 3
      for (const [p, sd, w, yy] of [[n0, s0, w0, y0], [n1, s1, w1, y1]] as [Station, THREE.Vector3, number, number][]) {
        const bo = pavedOffset(twoWayAt(p.s), kerbedAt(p.s))
        for (const o of [bo - w / 2, bo + w / 2]) bk2.pos.push(p.pos.x + sd.x * o, yy, p.pos.z + sd.z * o)
      }
      // uv in METRES here (blendMaterial divides by each set's metresPerTile)
      bk2.uv.push(0, n0.s, w0, n0.s, 0, n1.s, w1, n1.s)
      bk2.bl.push(0, 0, 1, 1)
      bk2.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
    // one quad, then the caller may yield. A whole carriageway in one turn is the drive hitch.
    yield
  }
  // the blend band and the paint are one more slice, not part of the last quad
  yield

  for (const [key, bk2] of Object.entries(blends)) {
    const [from, to] = key.split('>')
    const mat = blendFor(sets, from, to)
    if (!mat || bk2.idx.length === 0) continue
    const bg = new THREE.BufferGeometry()
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bk2.pos, 3))
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(bk2.uv, 2))
    bg.setAttribute('blend', new THREE.Float32BufferAttribute(bk2.bl, 1))
    bg.setIndex(bk2.idx)
    bg.computeVertexNormals()
    const mesh = new THREE.Mesh(bg, mat)
    mesh.name = `road:blend:${key}`
    mesh.receiveShadow = true
    g.add(mesh)
  }
  for (const [cls, bk] of Object.entries(byClass)) {
    const ag = new THREE.BufferGeometry()
    ag.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3))
    ag.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2))
    ag.setIndex(bk.idx)
    ag.computeVertexNormals()
    const mat = sets[cls]?.material ?? fallbackMaterial(cls)
    const mesh = new THREE.Mesh(ag, mat)
    mesh.name = `road:${cls}`
    mesh.receiveShadow = true
    g.add(mesh)
  }
  const mg = new THREE.BufferGeometry()
  mg.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3))
  mg.setAttribute('color', new THREE.Float32BufferAttribute(mcol, 3))
  mg.setIndex(midx)
  // the paint shader wants a normal: without one the attribute is absent and every normal reads
  // zero, and `mix(1.0, dot(NaN), 0.0)` is NaN, not 1.0 — GLSL's mix multiplies before it adds
  mg.computeVertexNormals()
  // Paint is LIT, and retroreflective. It used to be a MeshBasicMaterial, which ignores every
  // light in the scene by definition — so at midnight the lines glowed (Rich, 2026-09-27). See
  // retro.ts for why "lit" alone is not enough and what replaces the glow.
  const marksMat = paintMaterial(retro.uniforms, { vertexColors: true })
  retro.add(marksMat, 'paint')
  const marksMesh = new THREE.Mesh(mg, marksMat)
  marksMesh.name = 'road:markings' // probes read the paint off this geometry (probes/corridor-geometry.mjs)
  // the paint as laid, so a style can repaint it and the realistic style can put it back
  marksMesh.userData.paintAsLaid = Float32Array.from(mcol)
  g.add(marksMesh)
  return g
}

/** The whole ribbon in one turn. Load time and a fixture hole, where nothing is driving. */
export function roadMesh(st: Station[], lanesAt: (s: number) => number, classAt: (s: number) => string = () => 'asphalt_aged', sets: Record<string, SurfaceSet> = {}, lift = 0.02, twoWayAt: (s: number) => boolean = () => false, paintOff: ((x: number, z: number) => boolean) | null = null, kerbedAt: (s: number) => boolean = () => false, skipAt: ((s: number) => boolean) | null = null): THREE.Group {
  const gen = roadMeshGen(st, lanesAt, classAt, sets, lift, twoWayAt, paintOff, kerbedAt, skipAt)
  let step = gen.next()
  while (!step.done) step = gen.next()
  return step.value
}

/** The same ribbon, yielding every quad so a branch that comes online beside the car stays inside the frame budget. */
export async function roadMeshPaced(st: Station[], lanesAt: (s: number) => number, classAt: (s: number) => string, sets: Record<string, SurfaceSet>, lift: number, twoWayAt: (s: number) => boolean, paintOff: ((x: number, z: number) => boolean) | null, kerbedAt: (s: number) => boolean, skipAt: ((s: number) => boolean) | null, budget: Budget): Promise<THREE.Group> {
  const gen = roadMeshGen(st, lanesAt, classAt, sets, lift, twoWayAt, paintOff, kerbedAt, skipAt)
  let step = gen.next()
  while (!step.done) {
    await budget.tick()
    step = gen.next()
  }
  return step.value
}

/**
 * Repaint every marking in a road group: a vertex that was laid yellow (the centre line) takes
 * `centre`, one laid white takes `edge`. Yellow is told from white by the blue channel, which is
 * what separates the two paints in the colours `roadMesh` lays.
 */
export function repaintMarkings(road: THREE.Object3D, centre: THREE.Color, edge: THREE.Color) {
  road.traverse((o) => {
    const m = o as THREE.Mesh
    const laid = m.userData?.paintAsLaid as Float32Array | undefined
    if (!laid || !m.geometry) return
    const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    for (let i = 0; i < laid.length; i += 3) {
      const yellow = laid[i + 2] < 0.6 && laid[i] > 0.6
      const cc = yellow ? centre : edge
      arr[i] = cc.r
      arr[i + 1] = cc.g
      arr[i + 2] = cc.b
    }
    attr.needsUpdate = true
  })
}

/**
 * Trees from the canopy height model, at a FIXED density, around a centre.
 *
 * It used to walk the whole site and coarsen its cell — 6 m, 8 m, 10 m … up to 40 — until the
 * whole site's tree count fitted one global budget. That makes density a function of SITE SIZE:
 * measured on 2026-09-26, arrowhead-farms (0.68 km²) planted one tree per 6.1 m of canopy and
 * crofton-crownsville (355 km²) one per 34.2 m — the same woods, 31× thinner, which is exactly
 * what Rich saw ("trees still seem sparser in the crownsville and Crofton worlds than the
 * arrowhead farms world where I live").
 *
 * So the cell is fixed (`cellM`) and the budget is spent AROUND THE EYE instead: candidates
 * inside `radius` of the plant centre, nearest first, up to `budget`. A site ten times larger
 * now looks the same from the driver's seat; what it loses is trees beyond the radius, where the
 * imagery and the horizon drape already carry the woods.
 *
 * The lattice is WORLD-ALIGNED and every jitter is a hash of the cell indices, so a replant puts
 * every tree back exactly where it was; only the set near the eye changes. `plant` may be called
 * again with a new centre (the meshes and the record array are allocated once, at `budget`, and
 * the array is MUTATED IN PLACE so NearTrees' reference stays live).
 *
 * `TREE_PATCH` keeps that slot: a cell that was already planted stays at the same index, and only
 * the cells that entered or left are written. `TREE_SPARE_M` plants a ring past the draw radius
 * into those same slots and marks it `spare` — uploaded, not drawn — and evicts a cell once it
 * falls outside that ring so the budget is not spent on woods the eye has left.
 *
 * A later `plant` does not walk the disk again. Cells that stayed keep their slots; cells that
 * left are freed; only the crescent that entered is measured, and `pump` does that a few
 * milliseconds at a time. Those trees are out in the spare ring, so arriving over a second is
 * invisible from the driver's seat. When the budget is already full the rim is the farthest
 * set, so a new rim cell waits for a slot instead of sorting the whole disk.
 */
export interface TreePatch {
  /** the record list was rebuilt from scratch; every slot needs a matrix */
  rebuilt: boolean
  /** slots whose tree is new */
  changed: number[]
  /** slots that were freed */
  removed: number[]
  /** where each freed slot's tree stood, world x and z in pairs — the indexes that keyed on its position drop it from there */
  removedAt: number[]
  /** slots that left the spare ring and should be drawn */
  shown: number[]
  /** slots that fell into the spare ring and should hide */
  hidden: number[]
}
export function treesFromCanopy(
  chm: Float32Array,
  size: [number, number],
  bbox: [number, number, number, number],
  res: number,
  groundAt: (x: number, y: number) => number,
  budget: number,
  minH = 3,
  exclude: (x: number, y: number) => boolean = () => false,
  speciesAt?: (x: number, y: number) => string | null,
  opts: {
    /** canopy height at site (x, y); the default reads the raster passed in. A tiled site should
     * pass its TileSet's sampler: the tiles are 2 m where this overview is 8 m. */
    canopyAt?: (x: number, y: number) => number
    /** metres between candidate trees */
    cellM?: number
    /** plant no further than this from the centre */
    radius?: number
    /** site (x, y) to plant around */
    centre?: [number, number]
    /**
     * Measure only this disc on the first plant, then let `pump` fill out to the draw radius.
     * 0 keeps the old path: the whole disc is measured before the function returns.
     */
    seedM?: number
  } = {},
): { crowns: THREE.InstancedMesh; trunks: THREE.InstancedMesh; count: number; records: TreeRecord[]; refresh: (skip: Set<number>) => void; plant: (cx: number, cy: number) => number; pump: (budgetMs: number) => boolean; patch: () => TreePatch; forget: () => void; invalidateRegion: (x0: number, z0: number, x1: number, z1: number) => void; invalidateAll: () => void; stats: () => { count: number; cellM: number; radius: number; centre: [number, number]; capped: boolean; spare: number; drawn: number; changed: number; evicted: number; pending: number; pump: { cells: number; measured: number; placed: number; measureMaxMs: number; nextMs: number; ms: number } } } {
  const [w, h] = size
  const [xmin, , , ymax] = bbox
  const radius = opts.radius && opts.radius > 0 ? opts.radius : Infinity
  const capacity = Math.max(1, Math.round(budget))
  const sample =
    opts.canopyAt ??
    ((x: number, y: number) => {
      const c = Math.min(w - 1, Math.max(0, Math.floor((x - xmin) / res)))
      const r = Math.min(h - 1, Math.max(0, Math.floor((ymax - y) / res)))
      return chm[r * w + c]
    })
  const crownGeo = new THREE.IcosahedronGeometry(1, 1)
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 1, 5)
  trunkGeo.translate(0, 0.5, 0) // base at origin
  const crownMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 })
  // trunk only: the crown is a canopy and reaches over the road, which is what a tree is for
  installRoadClip(trunkMat)
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, capacity)
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, capacity)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const col = new THREE.Color()
  /** deterministic in the cell indices and a salt: the same cell always grows the same tree */
  const hash = (i: number, j: number, salt: number) => {
    let n = (i * 73856093) ^ (j * 19349663) ^ (salt * 83492791)
    n = (n ^ (n >>> 13)) >>> 0
    n = (Math.imul(n, 1274126177) ^ (n >>> 16)) >>> 0
    return n / 4294967296
  }
  // the tree list: measured position and height, kept so the near-field LOD can pick from it.
  // A hole (x = NaN) is a freed slot waiting to be reused, so a tree that stays keeps its index.
  type Rec = TreeRecord & { rad: number; hue: number; ci: number; cj: number; spare: boolean }
  const records: Rec[] = []
  const free: number[] = []
  const cellCache = new Map<string, { x: number; y: number; rec: Rec | null }>()
  let cacheStamp = ''
  let centre: [number, number] = opts.centre ?? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
  /** the cell and radius are read live at every plant, so F6 → trees → planting just replants */
  let capped = false
  let liveCount = 0
  let spareCount = 0
  let lastChanged = 0
  let lastEvicted = 0
  let patchNote: TreePatch = { rebuilt: true, changed: [], removed: [], removedAt: [], shown: [], hidden: [] }
  /** cells planted (or known empty) out to this centre. The next plant only queues the crescent past it. */
  let settled: [number, number] | null = null
  let settledR = 0
  const liveKeys = new Set<string>()
  /**
   * The crescent still to measure. A capped wood can leave a thick unplanted ring, so this is a
   * cursor, not a list: `pump` walks a few rows a frame instead of allocating every cell at once.
   */
  let scan: {
    cx: number
    cy: number
    contextR: number
    context2: number
    cellM: number
    ox: number
    oy: number
    settled2: number
    j: number
    jEnd: number
    jStep: number
    iStep: number
    row: number
    y0: number
    dy2: number
    spans: [number, number][]
    span: number
    i: number
  } | null = null
  /** a tree cell that did not fit in the budget; tried again before the cursor moves on */
  let hold: { i: number; j: number; x0: number; y0: number } | null = null
  /** what the last `pump` did: cells walked, cells measured, trees placed, the slowest measure, ms */
  const pumpStats = { cells: 0, measured: 0, placed: 0, measureMaxMs: 0, nextMs: 0, ms: 0 }
  const tally = () => {
    liveCount = 0
    spareCount = 0
    for (const r of records) if (Number.isFinite(r.x)) { liveCount++; if (r.spare) spareCount++ }
  }
  /** the tree a cell grows, or null. Cached while patching so the next ring does not resample the woods already seen. */
  const measure = (i: number, j: number, cellM: number, x0: number, y0: number, useCache: boolean): Rec | null => {
    if (x0 < bbox[0] || x0 > bbox[2] || y0 < bbox[1] || y0 > bbox[3]) return null
    const key = `${i},${j}`
    if (useCache) {
      const hit = cellCache.get(key)
      if (hit) return hit.rec
    }
    const hgt = sample(x0, y0)
    let rec: Rec | null = null
    if (hgt >= Math.max(0.2, T.TREE_MIN_H || minH) && !(T.TREE_DENSITY < 1 && hash(i, j, 9) > T.TREE_DENSITY)) {
      const jitter = cellM * 0.45
      const x = x0 + (hash(i, j, 1) - 0.5) * 2 * jitter
      const y = y0 + (hash(i, j, 2) - 0.5) * 2 * jitter
      const H = hgt * (0.9 + hash(i, j, 3) * 0.2) * T.TREE_HEIGHT_SCALE
      const rad = Math.min(7, Math.max(1.2, H * 0.28 * (0.8 + hash(i, j, 4) * 0.4)))
      if (!exclude(x, y)) {
        const sp = speciesAt?.(x, y) ?? undefined
        rec = { x, z: -y, y: groundAt(x, y), h: H, rad, hue: 0.27 + (hash(i, j, 5) - 0.5) * 0.05, species: sp as TreeRecord['species'], ci: i, cj: j, spare: false }
      }
    }
    if (useCache) cellCache.set(key, { x: x0, y: y0, rec })
    return rec
  }
  const adopt = (cx: number, cy: number, cellM: number, contextR: number) => {
    liveKeys.clear()
    let max2 = 0
    for (const r of records) {
      if (!Number.isFinite(r.x) || !Number.isFinite(r.ci)) continue
      liveKeys.add(`${r.ci},${r.cj}`)
      if (!capped) continue
      const dx = (r.ci + 0.5) * cellM - cx, dy = (r.cj + 0.5) * cellM - cy
      const d2 = dx * dx + dy * dy
      if (d2 > max2) max2 = d2
    }
    scan = null
    hold = null
    settled = [cx, cy]
    // a capped plant kept the nearest trees only. Cells past the farthest one kept were not
    // planted, so the next move has to be allowed to queue them. An uncapped plant covered the disk.
    settledR = capped && max2 > 0 ? Math.sqrt(max2) : contextR
  }
  /**
   * The cache trim, a few thousand entries a call. It used to walk all 350k entries the moment the
   * scan finished — 13 ms on the frame the crescent completed (2026-10-08). A Map may be iterated
   * while entries are deleted from it, so the walk is resumed across pump calls and the eye's
   * position is read fresh each time.
   */
  let trimIter: Iterator<[string, { x: number; y: number; rec: Rec | null }]> | null = null
  const trimCache = (cx: number, cy: number, contextR: number, cellM: number) => {
    if (!trimIter && cellCache.size <= 350000) return
    const lim = contextR + Math.max(50, T.TREE_REPLANT_M) + cellM
    const lim2 = lim * lim
    trimIter ??= cellCache.entries()
    for (let n = 0; n < 4000; n++) {
      const r = trimIter.next()
      if (r.done) { trimIter = null; return }
      const [k, v] = r.value
      const dx = v.x - cx, dy = v.y - cy
      if (dx * dx + dy * dy > lim2) cellCache.delete(k)
    }
  }
  /**
   * The eye moved. Trees already in a slot stay there. Cells that fell out of the ring are freed,
   * spare flags follow the draw radius, and only the crescent that was not planted yet is queued.
   * Measuring it happens in `pump`, a few milliseconds a frame.
   */
  const plantMoved = (cx: number, cy: number, cellM: number, drawR: number, contextR: number): number => {
    const draw2 = drawR * drawR
    const context2 = contextR * contextR
    const removed: number[] = []
    const removedAt: number[] = []
    const shown: number[] = []
    const hidden: number[] = []
    const ox = settled![0], oy = settled![1]
    const settled2 = settledR * settledR
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (!Number.isFinite(r.x)) continue
      const x0 = (r.ci + 0.5) * cellM, y0 = (r.cj + 0.5) * cellM
      const dx = x0 - cx, dy = y0 - cy
      const d2 = dx * dx + dy * dy
      if (d2 > context2) {
        if (r.spare) spareCount--
        liveCount--
        liveKeys.delete(`${r.ci},${r.cj}`)
        removedAt.push(r.x, r.z)
        r.x = NaN
        free.push(i)
        removed.push(i)
        continue
      }
      const spare = d2 > draw2
      if (r.spare !== spare) {
        spareCount += spare ? 1 : -1
        r.spare = spare
        if (spare) hidden.push(i)
        else shown.push(i)
      }
    }
    // restart the cursor at the new centre. Cells already planted are in liveKeys; ones measured
    // empty are in the cache. Either way the walk does not rebuild the list it has already passed.
    const j0 = Math.floor((cy - contextR) / cellM)
    const j1 = Math.ceil((cy + contextR) / cellM)
    const dj = cy - oy, di = cx - ox
    // walk the side the eye is moving toward first, so a full budget spends its slots on the
    // woods ahead rather than on the ring being left behind
    const jStep = dj >= Math.abs(di) ? -1 : 1
    const iStep = di >= Math.abs(dj) ? -1 : 1
    scan = {
      cx, cy, contextR, context2, cellM, ox, oy, settled2,
      j: jStep < 0 ? j1 : j0,
      jEnd: jStep < 0 ? j0 : j1,
      jStep, iStep,
      row: 0, y0: 0, dy2: 0, spans: [], span: 0, i: 0,
    }
    hold = null
    patchNote = { rebuilt: false, changed: [], removed, removedAt, shown, hidden }
    lastChanged = 0
    lastEvicted = removed.length
    return liveCount
  }
  /** the next unmeasured cell of the crescent, or null when the cursor is finished */
  const nextCell = (): { i: number; j: number; x0: number; y0: number } | null => {
    const s = scan
    if (!s) return null
    for (;;) {
      if (s.span < s.spans.length) {
        const [lo, hi] = s.spans[s.span]
        const past = s.iStep > 0 ? s.i > hi : s.i < lo
        if (!past) {
          const i = s.i
          s.i += s.iStep
          return { i, j: s.row, x0: (i + 0.5) * s.cellM, y0: s.y0 }
        }
        s.span++
        if (s.span < s.spans.length) {
          const [nlo, nhi] = s.spans[s.span]
          s.i = s.iStep > 0 ? nlo : nhi
        }
        continue
      }
      if (s.jStep > 0 ? s.j > s.jEnd : s.j < s.jEnd) {
        scan = null
        return null
      }
      const y0 = (s.j + 0.5) * s.cellM
      const dy = y0 - s.cy
      const dy2 = dy * dy
      s.row = s.j
      s.j += s.jStep
      s.spans = []
      s.span = 0
      s.i = 0
      if (dy2 > s.context2) continue
      const half = Math.sqrt(s.context2 - dy2)
      const iLo = Math.floor((s.cx - half) / s.cellM - 0.5) - 1
      const iHi = Math.ceil((s.cx + half) / s.cellM - 0.5) + 1
      const old2 = s.settled2 - (y0 - s.oy) * (y0 - s.oy)
      if (!(old2 > 0)) s.spans.push([iLo, iHi])
      else {
        const oh = Math.sqrt(old2)
        // shrink the skipped span by a cell so the boundary is decided by the distance test
        const oLo = Math.ceil((s.ox - oh) / s.cellM - 0.5) + 1
        const oHi = Math.floor((s.ox + oh) / s.cellM - 0.5) - 1
        const leftHi = Math.min(iHi, oLo - 1)
        const rightLo = Math.max(iLo, oHi + 1)
        if (iLo <= leftHi) s.spans.push([iLo, leftHi])
        if (rightLo <= iHi) s.spans.push([rightLo, iHi])
      }
      if (s.iStep < 0) s.spans.reverse()
      if (!s.spans.length) continue
      s.y0 = y0
      s.dy2 = dy2
      const sp = s.spans[0]
      s.i = s.iStep > 0 ? sp[0] : sp[1]
    }
  }
  /**
   * Measure crescent cells until the time budget runs out, and never more than 480 trees:
   * the seat uploads a partial range only up to 600 slots, and a full-buffer upload every frame
   * while the ring fills would be its own hitch. A cell that does not fit stays on the cursor
   * until a slot is freed, rather than sorting every tree in the disk.
   */
  const pump = (budgetMs: number): boolean => {
    if (!scan || !settled) return false
    const drawR = T.TREE_PLANT_RADIUS_M > 0 ? T.TREE_PLANT_RADIUS_M : Number.isFinite(radius) ? radius : Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    const draw2 = drawR * drawR
    const deadline = performance.now() + Math.max(0.25, budgetMs)
    const cellM = scan.cellM
    const scx = scan.cx
    const scy = scan.cy
    const context2 = scan.context2
    const changed: number[] = []
    let n = 0
    let placed = 0
    let measured = 0
    let measureMax = 0
    let nextMs = 0
    const pumpT0 = performance.now()
    while ((hold || scan) && placed < 480) {
      // every fourth cell, not every thirty-second: a cell asks the canopy, the road field, the
      // species raster and the ground, ~150 µs together, and thirty-two of them pushed a 0.75 ms
      // share to 6 ms (2026-10-08)
      if ((n & 3) === 0 && performance.now() >= deadline) break
      const c0 = performance.now()
      const c = hold ?? nextCell()
      nextMs += performance.now() - c0
      hold = null
      n++
      if (!c) break
      const key = `${c.i},${c.j}`
      if (liveKeys.has(key)) continue
      const dx = c.x0 - scx, dy = c.y0 - scy
      const d2 = dx * dx + dy * dy
      if (d2 > context2) continue
      const m0 = performance.now()
      const rec = measure(c.i, c.j, cellM, c.x0, c.y0, true)
      const mMs = performance.now() - m0
      measured++
      if (mMs > measureMax) measureMax = mMs
      if (!rec) continue
      if (free.length === 0 && records.length >= capacity) {
        // the rim waits for a slot freed by a tree that left the ring
        hold = c
        capped = true
        break
      }
      const spare = d2 > draw2
      const copy = { ...rec, spare }
      let i = free.pop()
      if (i === undefined) {
        i = records.length
        records.push(copy)
      } else records[i] = copy
      liveKeys.add(key)
      liveCount++
      if (spare) spareCount++
      changed.push(i)
      placed++
    }
    pumpStats.cells = n
    pumpStats.measured = measured
    pumpStats.placed = placed
    pumpStats.measureMaxMs = measureMax
    pumpStats.nextMs = nextMs
    pumpStats.ms = performance.now() - pumpT0
    if (!scan && !hold && settled) {
      settled = [centre[0], centre[1]]
      const spareM = T.TREE_PATCH > 0.5 ? Math.max(0, T.TREE_SPARE_M) : 0
      const contextR = drawR + spareM
      settledR = contextR
      capped = false
    }
    // the trim runs on every call while there is one in progress, and starts when the cache is big
    trimCache(centre[0], centre[1], (T.TREE_PLANT_RADIUS_M > 0 ? T.TREE_PLANT_RADIUS_M : drawR) + (T.TREE_PATCH > 0.5 ? Math.max(0, T.TREE_SPARE_M) : 0), Math.max(1, T.TREE_CELL_M || opts.cellM || 6))
    if (!changed.length) return false
    patchNote = { rebuilt: false, changed, removed: [], removedAt: [], shown: [], hidden: [] }
    lastChanged = changed.length
    lastEvicted = 0
    return true
  }
  const plant = (cx: number, cy: number): number => {
    centre = [cx, cy]
    const cellM = Math.max(1, T.TREE_CELL_M || opts.cellM || 6)
    const drawR = T.TREE_PLANT_RADIUS_M > 0 ? T.TREE_PLANT_RADIUS_M : Number.isFinite(radius) ? radius : Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1])
    const patch = T.TREE_PATCH > 0.5
    const spareM = patch ? Math.max(0, T.TREE_SPARE_M) : 0
    const contextR = drawR + spareM
    const stamp = `${cellM}|${T.TREE_MIN_H}|${T.TREE_DENSITY}|${T.TREE_HEIGHT_SCALE}|${T.TREE_ROAD_CLEAR_M}`
    if (stamp !== cacheStamp) {
      cellCache.clear()
    trimIter = null
      cacheStamp = stamp
      records.length = 0
      free.length = 0
      liveKeys.clear()
      scan = null
      hold = null
      settled = null
      settledR = 0
    }
    if (patch && settled && records.length > 0 && !records.some((r) => Number.isFinite(r.x) && !Number.isFinite(r.ci))) {
      return plantMoved(cx, cy, cellM, drawR, contextR)
    }
    // The first plant measures a seed disc. pump() already walks the crescent out to the draw
    // radius a few milliseconds at a time; doing the whole disc here is the startup hitch.
    // seedM 0, or a seed that covers the disc, is the old path.
    const seedM = opts.seedM && opts.seedM > 0 ? opts.seedM : 0
    const measureR = seedM > 0 && seedM < contextR ? seedM : contextR
    const i0 = Math.floor((cx - measureR) / cellM), i1 = Math.ceil((cx + measureR) / cellM)
    const j0 = Math.floor((cy - measureR) / cellM), j1 = Math.ceil((cy + measureR) / cellM)
    const draw2 = drawR * drawR
    const context2 = measureR * measureR
    const cand: { d2: number; rec: Rec; spare: boolean }[] = []
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = (i + 0.5) * cellM, y0 = (j + 0.5) * cellM
        const dx = x0 - cx, dy = y0 - cy
        const d2 = dx * dx + dy * dy
        if (d2 > context2) continue
        const rec = measure(i, j, cellM, x0, y0, patch)
        if (!rec) continue
        cand.push({ d2, rec, spare: d2 > draw2 })
      }
    }
    capped = cand.length > capacity
    if (capped) cand.sort((a, b) => a.d2 - b.d2)
    const take = Math.min(cand.length, capacity)
    if (!patch) {
      cellCache.clear()
    trimIter = null
      records.length = 0
      free.length = 0
      for (let k = 0; k < take; k++) records.push({ ...cand[k].rec, spare: false })
      patchNote = { rebuilt: true, changed: [], removed: [], removedAt: [], shown: [], hidden: [] }
      lastChanged = records.length
      lastEvicted = 0
      tally()
      adopt(cx, cy, cellM, contextR)
      return liveCount
    }
    records.length = 0
    free.length = 0
    for (let k = 0; k < take; k++) records.push({ ...cand[k].rec, spare: cand[k].spare })
    patchNote = { rebuilt: true, changed: [], removed: [], removedAt: [], shown: [], hidden: [] }
    lastChanged = records.length
    lastEvicted = 0
    tally()
    adopt(cx, cy, cellM, contextR)
    if (measureR < contextR) {
      settledR = measureR
      plantMoved(cx, cy, cellM, drawR, contextR)
    }
    return liveCount
  }
  const refresh = (skip: Set<number>) => {
    let k = 0
    for (let i = 0; i < records.length; i++) {
      if (skip.has(i)) continue
      const t = records[i]
      if (!Number.isFinite(t.x) || t.spare) continue
      // crown: a squashed icosahedron whose top is at the canopy height
      m.compose(new THREE.Vector3(t.x, t.y + t.h - t.rad * 0.95, t.z), q, new THREE.Vector3(t.rad, t.rad * 1.05, t.rad))
      crowns.setMatrixAt(k, m)
      const u = Math.min(1, t.h / 30)
      col.setHSL(t.hue, 0.42 - 0.12 * u, 0.34 - 0.14 * u)
      crowns.setColorAt(k, col)
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(1 + t.h / 20, Math.max(0.5, t.h - t.rad), 1 + t.h / 20))
      trunks.setMatrixAt(k, m)
      k++
    }
    crowns.count = k
    trunks.count = k
    crowns.instanceMatrix.needsUpdate = true
    trunks.instanceMatrix.needsUpdate = true
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true
  }
  plant(centre[0], centre[1])
  refresh(new Set())
  crowns.name = 'trees'
  trunks.name = 'trunks'
  /**
   * The canopy sample changed under cells already measured — a pyramid tile arrived after the first
   * pass recorded them as bare. Drop the empty answers and rescan the disk already planted, keeping
   * the trees that are standing. The next `plant` queues that disk instead of skipping it.
   */
  const forget = () => {
    cellCache.clear()
    trimIter = null
    settledR = 0
  }
  /**
   * The pavement under this ground changed — a lazy branch arrived, or a road-width knob moved.
   * Forget the cells and the standing trees the box touches, and let the next `plant` measure
   * them again.
   *
   * `pump` SKIPS any cell already in `liveKeys`, so a tree that was measured before the asphalt
   * existed is never re-asked and stays standing in the lane; the road mask then hides it and it
   * vanishes as the car reaches it (Rich, 2026-10-03). Freeing the slot and deleting the key puts
   * the cell back on the cursor, and `settledR = 0` makes the scan walk the whole disc instead of
   * the settled ring, so the re-measure is not skipped.
   */
  const invalidateRegion = (x0: number, z0: number, x1: number, z1: number) => {
    const cellM = Math.max(1, T.TREE_CELL_M || opts.cellM || 6)
    const m = Math.max(0, T.TREE_ROAD_CLEAR_M)
    const ax0 = Math.min(x0, x1) - m, ax1 = Math.max(x0, x1) + m
    const az0 = Math.min(z0, z1) - m, az1 = Math.max(z0, z1) + m
    // Cells are keyed on (i, j) in planter space, x east and y NORTH, so the box's z is -y. Visit
    // whichever is smaller: the box's cells by key, or the cache by its stored centres. This used
    // to split all ~350k cache keys on every arriving branch (11.8 % of the main thread on
    // dc-metro at Low, 2026-10-08), and it compared north against z, so it cleared the mirror
    // image of the box and left the cells under the new road cached.
    const i0 = Math.ceil(ax0 / cellM - 0.5), i1 = Math.floor(ax1 / cellM - 0.5)
    const j0 = Math.ceil(-az1 / cellM - 0.5), j1 = Math.floor(-az0 / cellM - 0.5)
    if (i1 >= i0 && j1 >= j0) {
      if ((i1 - i0 + 1) * (j1 - j0 + 1) <= cellCache.size) {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cellCache.delete(`${i},${j}`)
      } else {
        for (const [k, v] of cellCache) if (v.x >= ax0 && v.x <= ax1 && -v.y >= az0 && -v.y <= az1) cellCache.delete(k)
      }
    }
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (!Number.isFinite(r.x) || r.x < ax0 || r.x > ax1 || r.z < az0 || r.z > az1) continue
      cellCache.delete(`${r.ci},${r.cj}`)
      liveKeys.delete(`${r.ci},${r.cj}`)
      if (r.spare) spareCount--
      liveCount--
      r.x = NaN
      free.push(i)
    }
    settledR = 0
    scan = null
    hold = null
  }
  /** A width knob moved: re-measure every cell, not just one road's box. */
  const invalidateAll = () => {
    cellCache.clear()
    trimIter = null
    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (!Number.isFinite(r.x)) continue
      liveKeys.delete(`${r.ci},${r.cj}`)
      if (r.spare) spareCount--
      liveCount--
      r.x = NaN
      free.push(i)
    }
    settledR = 0
    scan = null
    hold = null
  }
  return { crowns, trunks, count: liveCount, records, refresh, plant, pump, patch: () => patchNote, forget, invalidateRegion, invalidateAll, stats: () => ({ count: liveCount, cellM: Math.max(1, T.TREE_CELL_M || opts.cellM || 6), radius: T.TREE_PLANT_RADIUS_M, centre, capped, spare: spareCount, drawn: liveCount - spareCount, changed: lastChanged, evicted: lastEvicted, pending: (scan ? Math.abs(scan.jEnd - scan.j) + 1 : 0) + (hold ? 1 : 0), pump: { ...pumpStats } }) }
}

/**
 * An overpass stand-in: a deck slab over our road on piers down to the measured ground.
 *
 * The parts a driver reads from below are the three thicknesses: the deck, the SOFFIT recessed
 * under it (so the edge overhangs and throws a line), and the girders under that. Above, the deck
 * carries concrete BARRIERS along the bridge road's own edges, and — where OSM records no support
 * and the carriageway below is wide enough to be divided — a COLUMN IN THE MEDIAN between the two
 * directions. Rich, 2026-10-06.
 */
export function overpassMesh(mid: Station, deckZ: number, deckLen: number, roadWidth: number, groundAt: (x: number, y: number) => number, colour = 0xb9b9b4, onRoad?: (x: number, z: number) => boolean): THREE.Group {
  const g = new THREE.Group()
  const side = mid.dir.clone().cross(UP)
  const span = roadWidth + 12 // deck reaches past both shoulders to where the piers stand
  const concrete = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9 })
  // A little lift so the underside is readable in its own shadow: a concrete soffit lit only by the
  // sky's ground colour came out as a black lid (Rich, 2026-10-06).
  const soffitMat = new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.95, emissive: 0x4a4844 })
  const depth = Math.max(2, deckLen)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 1.4, depth), concrete)
  deck.position.set(mid.pos.x, deckZ + 0.7, mid.pos.z)
  deck.rotation.y = Math.atan2(mid.dir.x, mid.dir.z)
  g.add(deck)
  /*
   * THE UNDERSIDE. The deck box already has a bottom, but a flat 17 m slab is a lid, not a bridge:
   * from the road below you read the structure by its SOFFIT — the recessed slab and the girders
   * running the span. One inset slab (so the edges overhang and cast a line) plus three girders is
   * enough at 40 m without pretending to be a box-girder section. Rich, 2026-10-06.
   */
  const soffit = new THREE.Mesh(new THREE.BoxGeometry(span - 1.6, 0.7, depth - 1.0), soffitMat)
  soffit.position.set(mid.pos.x, deckZ - 0.35, mid.pos.z)
  soffit.rotation.y = deck.rotation.y
  g.add(soffit)
  for (const gz of [-depth / 3, 0, depth / 3]) {
    const girder = new THREE.Mesh(new THREE.BoxGeometry(span - 2.0, 0.8, 0.6), soffitMat)
    girder.position.copy(soffit.position).add(new THREE.Vector3(0, -0.55, 0))
    girder.position.add(mid.dir.clone().multiplyScalar(gz))
    girder.rotation.y = deck.rotation.y
    g.add(girder)
  }
  // CONCRETE BARRIERS: one along each edge of the bridge road, sitting on the deck. The bridge
  // carries its own road across ours, so its parapets run the span and stand at the deck's
  // near/far edges (along `mid.dir`), not across the span.
  const barrier = new THREE.Mesh(new THREE.BoxGeometry(span, 1.15, 0.45), concrete)
  let supported = false
  for (const sgn of [-1, 1]) {
    const p = barrier.clone()
    p.position.copy(deck.position).add(mid.dir.clone().multiplyScalar((sgn * depth) / 2)).add(new THREE.Vector3(0, 1.28, 0))
    p.rotation.y = deck.rotation.y
    g.add(p)
    /*
     * A PIER DOES NOT STAND IN A ROADWAY. The pier sits at the edge of the span, which is where the
     * abutment is — but a crossing structure can land its base on a carriageway below (a ramp under
     * another ramp, a girder over a slip road), and a 1.6 m concrete post in a live lane reads as a
     * wall the car cannot see the reason for. If the call site can say what is a road, a pier whose
     * foot is on one is simply not built; the deck's own span carries it. Rich, 2026-10-06.
     */
    const px = mid.pos.x + side.x * sgn * (span / 2 - 1.2)
    const pz = mid.pos.z + side.z * sgn * (span / 2 - 1.2)
    if (onRoad?.(px, pz)) continue
    const gz = groundAt(px, -pz)
    const hgt = Math.max(1, deckZ - gz)
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, hgt, depth * 0.8), concrete)
    pier.position.set(px, gz + hgt / 2, pz)
    pier.rotation.y = deck.rotation.y
    g.add(pier)
    supported = true
  }
  /*
   * A SUPPORT IN THE MEDIAN. Where the structure has no OSM abutment it can use (both edge piers
   * landed on a live carriageway and were dropped), or the carriageway below is wide enough to be a
   * divided highway, the deck needs a column. It goes on the CENTRELINE — the middle of the two
   * lanes of traffic below — which is the one place a post is not in a driving lane. Generated only
   * where OSM left the structure unsupported, per Rich, 2026-10-06.
   */
  if (!supported || roadWidth >= 14) {
    const gz = groundAt(mid.pos.x, -mid.pos.z)
    const hgt = Math.max(1, deckZ - gz)
    const column = new THREE.Mesh(new THREE.BoxGeometry(2.0, hgt, Math.max(1.6, depth * 0.4)), concrete)
    column.position.set(mid.pos.x, gz + hgt / 2, mid.pos.z)
    column.rotation.y = deck.rotation.y
    g.add(column)
  }
  return g
}

/** Flat colours per surface class, for when the texture set has not been generated. */
export function fallbackMaterial(cls: string): THREE.Material {
  const colour: Record<string, number> = { asphalt_new: 0x26262a, asphalt_aged: 0x4a4a4c, asphalt_patched: 0x3a3a3d, concrete: 0x9a9890, chipseal: 0x6b665c, unknown: 0x444446 }
  const mat = new THREE.MeshStandardMaterial({ color: colour[cls] ?? colour.unknown, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
  chainCompile(mat, (shader) => injectFloodLamp(shader), 'fallback-flood-lamp')
  return mat
}

interface SurfaceEntry { name: string; albedo: string; normal: string; roughness: string; macro?: string; macro_metres?: number; metres_per_tile: number; variants?: { albedo: string; normal: string; roughness: string }[] }

/**
 * The same catalog, from the ASSET SERVICE: every material it holds, with the variants and the
 * macro map found by listing its files. This is where a deployed copy gets its textures — the
 * shipped pack under /surfaces/ is generated, gitignored and not in the image (Rich,
 * 2026-09-30: "the deployed version ships with no textures") — and the library is what a world
 * chooses its own textures from (surfacesdoc.ts), so it has to be loadable as sets anyway.
 */
async function serviceSurfaceCatalog(): Promise<{ sets: SurfaceEntry[] }> {
  const sets: SurfaceEntry[] = []
  const r = await fetch('/assetsvc/materials', { cache: 'no-cache' })
  if (!r.ok) return { sets }
  const list = ((await r.json()) as { materials?: { id: string; category?: string; metres_per_tile?: number; albedo?: string; normal?: string; roughness?: string }[] }).materials ?? []
  await Promise.all(list.map(async (m) => {
    let files: string[] = []
    try {
      const f = await fetch(`/assetsvc/materials/${encodeURIComponent(m.id)}/files`, { cache: 'no-cache' })
      if (f.ok) files = ((await f.json()) as { files?: string[] }).files ?? []
    } catch { /* no listing: the three named maps only */ }
    const at = (n: string) => `assetsvc/materials/${encodeURIComponent(m.id)}/file/${n}`
    const base = (p: string | undefined, dflt: string) => (p ? p.split('/').pop()! : dflt)
    const albedo = base(m.albedo, 'albedo.jpg'), normal = base(m.normal, 'normal.png'), rough = base(m.roughness, 'roughness.jpg')
    if (files.length && !files.includes(albedo)) return
    const variants = [{ albedo: at(albedo), normal: at(normal), roughness: at(rough) }]
    for (let i = 1; i < 8; i++) {
      const a = albedo.replace(/(\.[a-z0-9]+)$/i, `_${i}$1`), nn = normal.replace(/(\.[a-z0-9]+)$/i, `_${i}$1`), rr = rough.replace(/(\.[a-z0-9]+)$/i, `_${i}$1`)
      if (!files.includes(a)) break
      variants.push({ albedo: at(a), normal: at(files.includes(nn) ? nn : normal), roughness: at(files.includes(rr) ? rr : rough) })
    }
    const macro = files.find((f) => /^macro\./i.test(f))
    sets.push({ name: m.id, albedo: at(albedo), normal: at(normal), roughness: at(rough), macro: macro ? at(macro) : undefined, macro_metres: 8, metres_per_tile: m.metres_per_tile ?? 1, variants: variants.length > 1 ? variants : undefined })
  }))
  return { sets }
}

/** Load tools/surfaces output: a library of variants per class, hex-tiled at real scale. */
export async function loadSurfaceSets(base = '/surfaces/'): Promise<Record<string, SurfaceSet>> {
  const out: Record<string, SurfaceSet> = {}
  let cat: { sets: SurfaceEntry[] } = { sets: [] }
  try {
    const r = await fetch(`${base}surfaces.json`, { cache: 'no-cache' })
    if (r.ok) cat = await r.json()
  } catch {
    /* no shipped pack */
  }
  // the shipped pack first (it is the same maps, without a round trip per material); the
  // library for whatever it does not have — in a deployed copy, everything
  try {
    const svc = await serviceSurfaceCatalog()
    const have = new Set(cat.sets.map((s) => s.name))
    cat = { sets: [...cat.sets, ...svc.sets.filter((s) => !have.has(s.name))] }
  } catch {
    /* no service */
  }
  if (!cat.sets.length) return out
  const loader = new THREE.TextureLoader()
  const tex = (path: string, srgb: boolean) => {
    const t = loader.load(`/${path}`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const { arrayTexture } = await import('../visuals/hextile')
  const normalChunk = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = hexN;')
  for (const s of cat.sets) {
    // variant 0 stays on the material so three enables USE_MAP / USE_NORMALMAP and the uv varyings
    const mat = new THREE.MeshStandardMaterial({ map: tex(s.albedo, true), normalMap: tex(s.normal, false), normalScale: new THREE.Vector2(1.25, 1.25), roughnessMap: tex(s.roughness, false), roughness: 1, metalness: 0, side: THREE.DoubleSide })
    const variants = s.variants && s.variants.length > 1 ? s.variants : null
    let hex: SurfaceSet['hex'] | null = null
    if (variants) {
      const [albedo, normal] = await Promise.all([arrayTexture(variants.map((v) => `/${v.albedo}`), true), arrayTexture(variants.map((v) => `/${v.normal}`), false)])
      const macro = s.macro ? tex(s.macro, true) : null
      if (macro) macro.wrapS = macro.wrapT = THREE.MirroredRepeatWrapping
      const ratio = (s.macro_metres ?? 8) / s.metres_per_tile
      hex = { albedo, normal, layers: variants.length, macro, macroMetres: s.macro_metres ?? 8 }
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.hexAlbedo = { value: albedo }
        shader.uniforms.hexNormal = { value: normal }
        shader.uniforms.hexLayers = { value: variants.length }
        shader.uniforms.hexCell = { value: 1.6 }
        shader.uniforms.macroMap = { value: macro }
        shader.uniforms.macroRatio = { value: ratio }
        shader.uniforms.useMacro = { value: macro ? 1 : 0 }
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\n' + HEX_GLSL + '\nuniform sampler2D macroMap;\nuniform float macroRatio;\nuniform int useMacro;\nvec3 hexN = vec3(0.0, 0.0, 1.0);')
          .replace(
            '#include <map_fragment>',
            `
            #ifdef USE_MAP
              vec4 hexC = hexSample(vMapUv, hexN);
              if (useMacro == 1) {
                // the 8 m macro map (wheel tracks, patches, colour drift) modulates around mid grey
                vec3 mod3 = texture2D(macroMap, vMapUv / macroRatio).rgb * 2.0;
                hexC.rgb *= mix(vec3(1.0), mod3, 0.85);
              }
              diffuseColor *= hexC;
            #endif
            `,
          )
          .replace('#include <normal_fragment_maps>', normalChunk)
      }
      mat.customProgramCacheKey = () => `road-hex-${s.name}`
    }
    chainCompile(mat, (shader) => {
      injectRelief(shader)
      injectShade(shader)
      injectWetStreak(shader)
      injectFloodLamp(shader)
    }, 'relief-shade-wet-vert')
    out[s.name] = { name: s.name, metresPerTile: s.metres_per_tile, material: mat, hex: hex ?? undefined }
  }
  return out
}

/**
 * The verge: a ribbon of ground from the pavement edge out to `width` metres, following the road,
 * sitting a hair above the terrain so it carries a grass texture instead of the air photo's murk.
 * Two bands: the mown strip (0–8 m) and the rough beyond, each its own material. Blades stand on
 * top of this; from a car seat this ribbon is most of what "grass" is.
 */
export function vergeMesh(st: Station[], lanesAt: (s: number) => number, groundAt: (x: number, y: number) => number, mownMat: THREE.Material, roughMat: THREE.Material, otherEdge: (x: number, z: number) => number = () => Infinity, mownW = 8, roughW = 14, lift = 0.05): THREE.Group {
  const g = new THREE.Group()
  const bands: [number, number, THREE.Material][] = [[0, mownW, mownMat], [mownW, mownW + roughW, roughMat]]
  for (const [w0, w1, mat] of bands) {
    for (const sgn of [-1, 1]) {
      const pos: number[] = []
      const uv: number[] = []
      const idx: number[] = []
      for (let i = 0; i < st.length; i++) {
        const a = st[i]
        const half = pavedWidth(lanesAt(a.s)) / 2
        const side = a.dir.clone().cross(UP).multiplyScalar(sgn)
        // the ribbon stops 0.5 m short of any OTHER carriageway's pavement (the median side)
        let limit = half + w1
        for (let off = half; off <= half + w1; off += 1) {
          if (otherEdge(a.pos.x + side.x * off, a.pos.z + side.z * off) < 0.5) { limit = Math.max(half + w0 - 0.05, off - 1); break }
        }
        for (const off0 of [half + w0 - 0.05, half + w1]) {
          const off = Math.min(off0, limit)
          const x = a.pos.x + side.x * off, z = a.pos.z + side.z * off
          const y = groundAt(x, -z) + lift
          pos.push(x, y, z)
          uv.push(off / 2, a.s / 2)
        }
        if (i > 0) {
          const k = (i - 1) * 2
          if (sgn > 0) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
          else idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
        }
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = `verge:${w0 === 0 ? 'mown' : 'rough'}`
      g.add(mesh)
    }
  }
  return g
}
