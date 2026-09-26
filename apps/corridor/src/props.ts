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
import { HEX_GLSL } from './hextile'
import type { TreeRecord } from './trees'

import * as T from './tuning'

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
export function taperedLanes(lanesAt: (s: number) => number, length: number, taper = T.ROAD_TAPER_M, step = 2): (s: number) => number {
  const n = Math.max(2, Math.ceil(length / step) + 1)
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = lanesAt(i * step)
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
  return (s) => {
    const x = Math.min(n - 1, Math.max(0, s / step))
    const i = Math.floor(x), f = x - i
    return out[i] * (1 - f) + out[Math.min(n - 1, i + 1)] * f
  }
}

/** Width of the paved surface at station s: lanes × 3.66 + both shoulders. */
export function pavedWidth(lanes: number, twoWay = false): number {
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
export function pavedOffset(twoWay = false): number {
  if (twoWay || T.ROAD_ONEWAY_CENTRE >= 0.5) return 0
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
  const mat = new THREE.MeshStandardMaterial({ map: base.map, normalMap: base.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: base.roughnessMap, roughness: 1, metalness: 0, side: THREE.DoubleSide })
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
export function roadMesh(st: Station[], lanesAt: (s: number) => number, classAt: (s: number) => string = () => 'asphalt_aged', sets: Record<string, SurfaceSet> = {}, lift = 0.02, twoWayAt: (s: number) => boolean = () => false, paintOff: ((x: number, z: number) => boolean) | null = null): THREE.Group {
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
    const wa = pavedWidth(la, twoWay), wb = pavedWidth(lb, twoWay)
    // the asphalt's centre, right of the spine: 0 for a two-way road, half the shoulder difference
    // for a carriageway (see pavedOffset)
    const off = pavedOffset(twoWay)
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
    // crosses the blend band without a gap and without fighting it.
    const ml = 0.12, y2a = ya + 0.02, y2b = yb + 0.02
    // is this line, at this lateral offset, inside a junction? test both ends of the quad
    const off2 = (oa: number, ob: number) =>
      !!paintOff && (paintOff(a.pos.x + sa.x * oa, a.pos.z + sa.z * oa) || paintOff(b.pos.x + sb.x * ob, b.pos.z + sb.z * ob))
    const cycle = Math.floor(a0.s / 12) * 12
    const dash = a0.s - cycle < 3.01 && Math.round(la) === Math.round(lb)
    const dashLen = Math.min(3, b0.s - a0.s)
    const bb = a0.pos.clone().add(a0.dir.clone().multiplyScalar(dashLen))
    if (twoWay) {
      // two-way: white edge lines on both shoulders, double yellow at the centre, white dashes
      // between the lanes of each direction (3+ lanes a side)
      const edgeA = wa / 2 - T.SHOULDER_OUT + off, edgeB = wb / 2 - T.SHOULDER_OUT + off
      for (const sgn of [-1, 1]) { if (off2(sgn * edgeA, sgn * edgeB)) continue; quad(marks, midx, P(a.pos, sa, sgn * edgeA - ml, y2a), P(a.pos, sa, sgn * edgeA + ml, y2a), P(b.pos, sb, sgn * edgeB - ml, y2b), P(b.pos, sb, sgn * edgeB + ml, y2b), white, mcol) }
      for (const off of [-0.16, 0.16]) { if (off2(off, off)) continue; quad(marks, midx, P(a.pos, sa, off - 0.1, y2a), P(a.pos, sa, off + 0.1, y2a), P(b.pos, sb, off - 0.1, y2b), P(b.pos, sb, off + 0.1, y2b), yellow, mcol) }
      const perSide = Math.max(1, Math.floor(la / 2))
      if (dash) for (const sgn of [-1, 1]) for (let l = 1; l < perSide; l++) {
        const off = sgn * l * T.LANE_WIDTH
        if (off2(off, off)) continue
        quad(marks, midx, P(a.pos, sa, off - 0.08, y2a), P(a.pos, sa, off + 0.08, y2a), P(bb, sa, off - 0.08, y2a), P(bb, sa, off + 0.08, y2a), white, mcol)
      }
    } else {
      // one-way carriageway: yellow left (median side), white right, on the shoulder boundaries
      const leftA = -wa / 2 + T.SHOULDER_IN + off, leftB = -wb / 2 + T.SHOULDER_IN + off
      const rightA = wa / 2 - T.SHOULDER_OUT + off, rightB = wb / 2 - T.SHOULDER_OUT + off
      if (!off2(leftA, leftB)) quad(marks, midx, P(a.pos, sa, leftA - ml, y2a), P(a.pos, sa, leftA + ml, y2a), P(b.pos, sb, leftB - ml, y2b), P(b.pos, sb, leftB + ml, y2b), yellow, mcol)
      if (!off2(rightA, rightB)) quad(marks, midx, P(a.pos, sa, rightA - ml, y2a), P(a.pos, sa, rightA + ml, y2a), P(b.pos, sb, rightB - ml, y2b), P(b.pos, sb, rightB + ml, y2b), white, mcol)
      // lane dashes: 3 m paint / 9 m gap is the US standard; one dash per 12 m station cycle
      if (dash) for (let l = 1; l < la; l++) {
        const off = leftA + l * T.LANE_WIDTH
        if (off2(off, off)) continue
        quad(marks, midx, P(a.pos, sa, off - 0.08, y2a), P(a.pos, sa, off + 0.08, y2a), P(bb, sa, off - 0.08, y2a), P(bb, sa, off + 0.08, y2a), white, mcol)
      }
    }

    // the transition strip into the gap this quad's trimmed end left
    if (cutEnd > 0 && T.ROAD_BLEND_M > 0) {
      const from = quadClass[i], to = quadClass[i + 1]
      const key = `${from}>${to}`
      const bk2 = (blends[key] ??= { pos: [], uv: [], idx: [], bl: [] })
      const n0 = lerpSt(a0, b0, 1 - cutEnd / span) // = b
      const nextSpan = st[i + 2] ? st[i + 2].s - b0.s || 1 : span
      const n1 = st[i + 2] ? lerpSt(b0, st[i + 2], Math.min(T.ROAD_BLEND_M / 2, nextSpan * 0.4) / nextSpan) : b0
      const w0 = pavedWidth(lanesAt(n0.s), twoWayAt(n0.s)), w1 = pavedWidth(lanesAt(n1.s), twoWayAt(n1.s))
      const s0 = n0.dir.clone().cross(UP), s1 = n1.dir.clone().cross(UP)
      const y0 = n0.pos.y + lift, y1 = n1.pos.y + lift
      const k = bk2.pos.length / 3
      for (const [p, sd, w, yy] of [[n0, s0, w0, y0], [n1, s1, w1, y1]] as [Station, THREE.Vector3, number, number][]) {
        const bo = pavedOffset(twoWayAt(p.s))
        for (const o of [bo - w / 2, bo + w / 2]) bk2.pos.push(p.pos.x + sd.x * o, yy, p.pos.z + sd.z * o)
      }
      // uv in METRES here (blendMaterial divides by each set's metresPerTile)
      bk2.uv.push(0, n0.s, w0, n0.s, 0, n1.s, w1, n1.s)
      bk2.bl.push(0, 0, 1, 1)
      bk2.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
  }

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
    g.add(mesh)
  }
  const mg = new THREE.BufferGeometry()
  mg.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3))
  mg.setAttribute('color', new THREE.Float32BufferAttribute(mcol, 3))
  mg.setIndex(midx)
  const marksMesh = new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }))
  marksMesh.name = 'road:markings' // probes read the paint off this geometry (probes/corridor-geometry.mjs)
  // the paint as laid, so a style can repaint it and the realistic style can put it back
  marksMesh.userData.paintAsLaid = Float32Array.from(mcol)
  g.add(marksMesh)
  return g
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
 * Trees from the canopy height model: walk the CHM on a coarse cell, and where the canopy is
 * taller than `minH` plant one tree of that height, jittered inside the cell. Two instanced
 * meshes (crowns, trunks). `budget` caps the count for the GPU at hand; the cell grows to fit.
 */
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
): { crowns: THREE.InstancedMesh; trunks: THREE.InstancedMesh; count: number; records: TreeRecord[]; refresh: (skip: Set<number>) => void } {
  const [w, h] = size
  const [xmin, , , ymax] = bbox
  // count candidate cells at the finest useful cell (6 m), then coarsen until under budget
  let cellM = 6
  let count = 0
  let stride = Math.max(1, Math.round(cellM / res))
  for (;;) {
    count = 0
    for (let r = 0; r < h; r += stride) for (let c = 0; c < w; c += stride) if (chm[r * w + c] >= minH) count++
    if (count <= budget || cellM >= 40) break
    cellM += 2
    stride = Math.max(1, Math.round(cellM / res))
  }
  const crownGeo = new THREE.IcosahedronGeometry(1, 1)
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.22, 1, 5)
  trunkGeo.translate(0, 0.5, 0) // base at origin
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), Math.max(1, count))
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }), Math.max(1, count))
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const col = new THREE.Color()
  let rnd = 1234567
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  // the tree list: measured position and height, kept so the near-field LOD can pick from it
  const records: (TreeRecord & { rad: number; hue: number })[] = []
  for (let r = 0; r < h && records.length < count; r += stride) {
    for (let c = 0; c < w && records.length < count; c += stride) {
      const hgt = chm[r * w + c]
      if (hgt < minH) continue
      const jitter = cellM * 0.45
      const x = xmin + (c + 0.5) * res + (rand() - 0.5) * 2 * jitter
      const y = ymax - (r + 0.5) * res + (rand() - 0.5) * 2 * jitter
      const H = hgt * (0.9 + rand() * 0.2)
      const rad = Math.min(7, Math.max(1.2, H * 0.28 * (0.8 + rand() * 0.4)))
      if (exclude(x, y)) continue
      const sp = speciesAt?.(x, y) ?? undefined
      records.push({ x, z: -y, y: groundAt(x, y), h: H, rad, hue: 0.27 + (rand() - 0.5) * 0.05, species: sp as TreeRecord['species'] })
    }
  }
  const refresh = (skip: Set<number>) => {
    let k = 0
    for (let i = 0; i < records.length; i++) {
      if (skip.has(i)) continue
      const t = records[i]
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
  refresh(new Set())
  crowns.name = 'trees'
  trunks.name = 'trunks'
  return { crowns, trunks, count: records.length, records, refresh }
}

/** An overpass stand-in: a deck slab over our road on two piers down to the measured ground. */
export function overpassMesh(mid: Station, deckZ: number, deckLen: number, roadWidth: number, groundAt: (x: number, y: number) => number, colour = 0xb9b9b4): THREE.Group {
  const g = new THREE.Group()
  const side = mid.dir.clone().cross(UP)
  const span = roadWidth + 12 // deck reaches past both shoulders to where the piers stand
  const concrete = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9 })
  const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 1.4, Math.max(2, deckLen)), concrete)
  deck.position.set(mid.pos.x, deckZ + 0.7, mid.pos.z)
  deck.rotation.y = Math.atan2(mid.dir.x, mid.dir.z)
  g.add(deck)
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(span, 1.1, 0.3), concrete)
  for (const sgn of [-1, 1]) {
    const p = parapet.clone()
    p.position.copy(deck.position).add(mid.dir.clone().multiplyScalar((sgn * Math.max(2, deckLen)) / 2)).add(new THREE.Vector3(0, 1.2, 0))
    p.rotation.y = deck.rotation.y
    g.add(p)
    const px = mid.pos.x + side.x * sgn * (span / 2 - 1.2)
    const pz = mid.pos.z + side.z * sgn * (span / 2 - 1.2)
    const gz = groundAt(px, -pz)
    const hgt = Math.max(1, deckZ - gz)
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, hgt, Math.max(2, deckLen) * 0.8), concrete)
    pier.position.set(px, gz + hgt / 2, pz)
    pier.rotation.y = deck.rotation.y
    g.add(pier)
  }
  return g
}

/** Flat colours per surface class, for when the texture set has not been generated. */
export function fallbackMaterial(cls: string): THREE.Material {
  const colour: Record<string, number> = { asphalt_new: 0x26262a, asphalt_aged: 0x4a4a4c, asphalt_patched: 0x3a3a3d, concrete: 0x9a9890, chipseal: 0x6b665c, unknown: 0x444446 }
  return new THREE.MeshStandardMaterial({ color: colour[cls] ?? colour.unknown, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
}

/** Load tools/surfaces output: a library of variants per class, hex-tiled at real scale. */
export async function loadSurfaceSets(base = '/surfaces/'): Promise<Record<string, SurfaceSet>> {
  const out: Record<string, SurfaceSet> = {}
  interface Entry { name: string; albedo: string; normal: string; roughness: string; macro?: string; macro_metres?: number; metres_per_tile: number; variants?: { albedo: string; normal: string; roughness: string }[] }
  let cat: { sets: Entry[] }
  try {
    const r = await fetch(`${base}surfaces.json`, { cache: 'no-cache' })
    if (!r.ok) return out
    cat = await r.json()
  } catch {
    return out
  }
  const loader = new THREE.TextureLoader()
  const tex = (path: string, srgb: boolean) => {
    const t = loader.load(`/${path}`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = 8
    if (srgb) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  const { arrayTexture } = await import('./hextile')
  const normalChunk = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = hexN;')
  for (const s of cat.sets) {
    // variant 0 stays on the material so three enables USE_MAP / USE_NORMALMAP and the uv varyings
    const mat = new THREE.MeshStandardMaterial({ map: tex(s.albedo, true), normalMap: tex(s.normal, false), normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: tex(s.roughness, false), roughness: 1, metalness: 0, side: THREE.DoubleSide })
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
