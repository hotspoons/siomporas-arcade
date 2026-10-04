// Water: the streams, rivers, ponds and falls water.py measured (manifest.water), drawn where the
// lidar says the channel is.
//
//   lines   a ribbon per waterway, `width_m` wide, following the snapped points at the DTM low
//           line plus WATER_DEPTH (a stream is not a film on its bed). Culvert segments are not
//           drawn — the water goes under the road fill and comes out the other side.
//   areas   ponds/basins/wetlands as a flat polygon at the median ground inside them.
//   meshes  one per MATERIAL, not per waterway — a region can hold hundreds of streams (Crofton:
//           416 lines, 129 rapids, 199 ponds) and they share three materials between them. Bodies
//           that name the same `look` share a material; nothing picks an individual stream.
//   falls   over a fall or rapid a second, brighter ribbon carries scrolling foam.
//   look    MeshStandardMaterial (so the log-depth and fog chunks come for free) with the shading
//           normal replaced by a summed Gerstner wave normal over world position and time — waves
//           that travel along the channel (or along the wind over a pond/sea), not a scrolling
//           pattern — plus depth-driven colour extinction and shore foam. The Gerstner model,
//           extinction and foam are ported from tuxalin/water-shader (MIT, (c) 2017 tuxalin) in
//           ./waterShader.ts. A body's `look` names a WaterLook preset (`swamp`, `black`,
//           `caribbean`, …) so a game can dial one stream or the whole sea from bog to reef; see
//           WATER_PRESETS. The Environment ▸ water knobs scale every body at once.
//
// KNOWN GAP: within 0.6 m of any pavement the corridor strip sits at road height, so water under a
// bridge we are on is hidden by the strip deck until the strip learns to open over decks (main's).
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as T from '../tuning'
import { chainCompile, injectRelief, injectShade, noteShiny } from '../visuals/shading'
import { WATER_ATTR, WATER_FRAG_COLOR, WATER_FRAG_NORMAL, WATER_FRAG_PARS, WATER_LOOK_NAMES, WATER_VERT_BODY, WATER_VERT_PARS, applyLookColours, lookOf, refreshLook, waterTints, writeWaterAttr, type WaterKnobs, type WaterLook, type WaterWaveUniforms } from './waterShader'

export interface WaterFall { i0: number; i1: number; drop_m: number; length_m: number; grade: number; kind: 'falls' | 'rapids' }
export interface WaterLine {
  id: string
  kind: string
  name: string | null
  width_m: number
  culvert: boolean
  intermittent?: boolean
  length_m: number
  fall_m: number
  pts: [number, number, number][] // site x, y relative to origin, z NAVD88
  falls: WaterFall[]
  /** optional WaterLook preset name; defaults to the site's default look */
  look?: string
}
export interface WaterArea { id: string; kind: string; name: string | null; area_m2: number; z: number; ring: [number, number][]; look?: string }
export interface WaterLayer { lines: WaterLine[]; areas: WaterArea[]; summary?: Record<string, unknown> }

/**
 * How far above `WATER_LEVEL_M` the sea plane is drawn, in metres. A draw bias to beat z-fighting
 * with the flat-at-zero coastal DEM; see `placeSea`.
 */
const SEA_DRAW_LIFT = 0.35

const GLSL_NOISE = /* glsl */ `
  float wh21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh21(i), wh21(i + vec2(1, 0)), u.x), mix(wh21(i + vec2(0, 1)), wh21(i + vec2(1, 1)), u.x), u.y);
  }
`

interface WaterShared {
  uTime: { value: number }
  uWind: { value: THREE.Vector2 }
}

/** the live global multipliers, read fresh so the Environment ▸ water dials are hot */
const knobs = (): WaterKnobs => ({
  wave: T.WATER_WAVE_STRENGTH,
  amp: T.WATER_WAVE_AMP,
  len: T.WATER_WAVE_LEN,
  steep: T.WATER_WAVE_STEEP,
  foam: T.WATER_FOAM,
  band: T.WATER_FOAM_BAND,
  clarity: T.WATER_CLARITY,
  fade: T.WATER_WAVE_FADE,
})

/** wind direction in the world XZ plane, from the compass-style knob */
export function waterWind(): THREE.Vector2 {
  const a = (T.WATER_WIND_DEG * Math.PI) / 180
  return new THREE.Vector2(Math.cos(a), Math.sin(a))
}

function waterMaterial(shared: WaterShared, look: WaterLook, opacityMul = 1): THREE.MeshStandardMaterial {
  const u: WaterWaveUniforms = {
    uTime: shared.uTime,
    uWind: shared.uWind,
    uWaveStrength: { value: 0 },
    uWaveAmp: { value: 1 },
    uWaveLen: { value: 1 },
    uWaveSteep: { value: 1 },
    uShoreColor: { value: new THREE.Color(look.shore) },
    uDepthColor: { value: new THREE.Color(look.deep) },
    uExtinct: { value: new THREE.Vector3(look.extinct[0], look.extinct[1], look.extinct[2]) },
    uFoamAmount: { value: 0 },
    uFoamBand: { value: 1 },
    uShoreMix: { value: look.shoreMix },
    uWaveFade: { value: 1 },
  }
  applyLookColours(u, look)
  refreshLook(u, look, knobs())
  const mat = new THREE.MeshStandardMaterial({ color: look.colour, roughness: look.roughness, metalness: 0.05, transparent: true, opacity: Math.min(0.98, look.opacity * opacityMul), depthWrite: true, side: THREE.DoubleSide })
  mat.userData.water = { u, look } as { u: WaterWaveUniforms; look: WaterLook }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime
    shader.uniforms.uWind = u.uWind
    shader.uniforms.uWaveStrength = u.uWaveStrength
    shader.uniforms.uWaveAmp = u.uWaveAmp
    shader.uniforms.uWaveLen = u.uWaveLen
    shader.uniforms.uWaveSteep = u.uWaveSteep
    shader.uniforms.uShoreColor = u.uShoreColor
    shader.uniforms.uDepthColor = u.uDepthColor
    shader.uniforms.uExtinct = u.uExtinct
    shader.uniforms.uFoamAmount = u.uFoamAmount
    shader.uniforms.uFoamBand = u.uFoamBand
    shader.uniforms.uShoreMix = u.uShoreMix
    shader.uniforms.uWaveFade = u.uWaveFade
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WATER_VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WATER_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WATER_FRAG_PARS)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n' + WATER_FRAG_NORMAL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WATER_FRAG_COLOR)
      .replace(
        '#include <normal_fragment_maps>',
        `
        #include <normal_fragment_maps>
        {
          // from a car the water is seen at a slant. The sky reflection is that slant, not the
          // sun's highlight, which at noon sits overhead and out of the windscreen. The normal
          // is declared in normal_fragment_begin, which is why this cannot live in color_fragment.
          float ndv = clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 3.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.55, 1.7, 1.75), fres * 0.65);
        }
        `,
      )
  }
  mat.customProgramCacheKey = () => `corridor-water-${look.colour}`
  noteShiny(mat)
  // NO SSR. The screen-space pass marches to a fixed "belt" row and samples the previous frame at a
  // linearly shifted X; over a body the size of the sea that X runs off the texture along a straight
  // line, so half the water takes a smeared flat sample and half does not — a hard-edged plate laid
  // on the ocean. The sky environment (REFLECT) already gives the water its reflection, cleanly.
  chainCompile(mat, (shader) => {
    injectRelief(shader)
    injectShade(shader)
  }, 'relief-shade')
  return mat
}

function foamMaterial(uniforms: { uTime: { value: number } }): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: 0xf4f8fa, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFoamPos;\nvarying vec2 vFoamUv;\nattribute vec2 aFoam;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoamPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvFoamUv = aFoam;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vFoamPos;\nvarying vec2 vFoamUv;\n' + GLSL_NOISE)
      .replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        {
          // streaks racing down the fall, fading at the ribbon's edges
          float along = vFoamUv.y * 6.0 - uTime * 2.2;
          float n = wnoise(vec2(vFoamUv.x * 9.0, along)) * 0.7 + wnoise(vec2(vFoamUv.x * 23.0, along * 2.0)) * 0.3;
          float edge = smoothstep(0.0, 0.25, vFoamUv.x) * smoothstep(1.0, 0.75, vFoamUv.x);
          diffuseColor.a *= clamp(n * 1.6 - 0.35, 0.0, 1.0) * edge;
        }
        `,
      )
  }
  mat.customProgramCacheKey = () => 'corridor-foam'
  return mat
}

/**
 * The still-water plane: the sea, and the flood.
 *
 * Every site is quoted in metres NAVD88, so a plane at 0 is sea level everywhere and is simply
 * buried under the terrain at an inland site — no per-site switch, no coastal flag. Raising
 * `WATER_LEVEL_M` fills the valleys from the bottom, which is trailworks' flooding mechanic in
 * one number (Rich, 2026-09-21). Two triangles, so the cost of having it always on is nothing.
 */
function seaPlane(uniforms: WaterShared, look: WaterLook): THREE.Mesh {
  // Tessellated, NOT one quad. A single 60 km triangle spends its precision on interpolation: the
  // shared diagonal of the two triangles showed through as a hard edge with ripples on one side and
  // flat water on the other, because world position and view distance are interpolated across an
  // enormous triangle. 64 segments makes the longest edge under a kilometre, which the varyings
  // carry exactly — and gives a mesh fine enough to displace for real swell later.
  const geo = new THREE.PlaneGeometry(1, 1, 64, 64)
  geo.rotateX(-Math.PI / 2)
  const mat = waterMaterial(uniforms, look, 1.18)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'water:level'
  mesh.renderOrder = 1
  mesh.frustumCulled = false
  return mesh
}

/**
 * A ribbon along world-frame points with per-point width; `uvAttr` names an optional (across,
 * along) attribute. With `crown`, each station emits three vertices (bank, centre, bank) so the
 * depth attribute has a bank-to-centre profile — 0 at the waterline, `crown` at the middle — which
 * is what puts tuxalin's shore foam on the banks and a deep tint down the channel.
 */
function ribbon(points: THREE.Vector3[], width: (i: number) => number, uvAttr?: string, depthAt?: (p: THREE.Vector3) => number, crown?: number): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const water: number[] = []
  const idx: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const dir = new THREE.Vector3()
  const side = new THREE.Vector3()
  const crowned = crown !== undefined
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    dir.copy(b).sub(a).setY(0)
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0)
    dir.normalize()
    side.copy(dir).cross(up).multiplyScalar(width(i) / 2)
    const p = points[i]
    const along = i / Math.max(1, points.length - 1)
    if (crowned) {
      // bank (0) → centre (crown) → bank (0)
      pos.push(p.x - side.x, p.y, p.z - side.z, p.x, p.y, p.z, p.x + side.x, p.y, p.z + side.z)
      uv.push(0, along, 0.5, along, 1, along)
      water.push(0, dir.x, dir.z, crown, dir.x, dir.z, 0, dir.x, dir.z)
      if (i > 0) {
        const k = (i - 1) * 3
        idx.push(k, k + 3, k + 1, k + 1, k + 3, k + 4, k + 1, k + 4, k + 2, k + 2, k + 4, k + 5)
      }
    } else {
      pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z)
      uv.push(0, along, 1, along)
      const d = depthAt ? depthAt(p) : 0
      water.push(d, dir.x, dir.z, d, dir.x, dir.z)
      if (i > 0) {
        const k = (i - 1) * 2
        idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  if (uvAttr) g.setAttribute(uvAttr, new THREE.Float32BufferAttribute(uv, 2))
  if (depthAt || crowned) g.setAttribute(WATER_ATTR, new THREE.Float32BufferAttribute(water, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

export interface WaterResult {
  group: THREE.Group
  /** advance the ripples */
  tick: (time: number) => void
  lines: number
  areas: number
  falls: number
  /** metres of channel drawn */
  length_m: number
  /** a style's water: stream, still, and the sea plane */
  setColours: (stream: THREE.Color, still: THREE.Color, sea: THREE.Color, opacityBias?: number) => void
  /** point the default look (bodies that did not name one) at a preset, or null for the WATER_LOOK dial */
  setLook: (name: string | null) => void
  /** the look names present in this build, for a UI to list */
  looks: string[]
}

/**
 * Build the water. `groundAt(x, z)` is world-frame; used only to keep a ribbon from sinking under
 * the strip where the strip has re-graded the verge (the surface is max(channel, ground − 0.3)).
 */
export function buildWater(water: WaterLayer | null | undefined, groundAt: (x: number, z: number) => number | null): WaterResult {
  const group = new THREE.Group()
  group.name = 'water'
  const uniforms: WaterShared = {
    uTime: { value: 0 },
    uWind: { value: waterWind() },
  }
  // the default look for bodies that do not name one; the Environment ▸ water selector picks it
  const defaultLookNameOf = () => WATER_LOOK_NAMES[Math.min(WATER_LOOK_NAMES.length - 1, Math.max(0, Math.round(T.WATER_LOOK)))] ?? 'temperate'
  let defaultLookOverride: string | null = null
  const defaultLookName = defaultLookNameOf()
  const defaultLook = lookOf(defaultLookName)

  // every water material, so the tick can refresh its uniforms from the live knobs. `own` pins a
  // body that named its look; the rest follow the default, so the WATER_LOOK dial and setLook are
  // live for them without a rebuild.
  interface Tracked { u: WaterWaveUniforms; look: WaterLook; name: string; own: boolean; mat: THREE.MeshStandardMaterial; styleColoured: boolean }
  const waveMats: Tracked[] = []
  const makeMat = (look: WaterLook, name: string, own: boolean, opacityMul = 1) => {
    const mat = waterMaterial(uniforms, look, opacityMul)
    waveMats.push({ u: (mat.userData.water as { u: WaterWaveUniforms }).u, look, name, own, mat, styleColoured: false })
    return mat
  }

  const sea = seaPlane(uniforms, defaultLook)
  group.add(sea)
  // the sea is deep: no shore tint or foam anywhere on the plane itself (it meets land elsewhere)
  const seaWind = waterWind()
  writeWaterAttr(sea.geometry, () => [60, seaWind.x, seaWind.y])
  const seaMat = sea.material as THREE.MeshStandardMaterial
  waveMats.push({ u: (seaMat.userData.water as { u: WaterWaveUniforms }).u, look: defaultLook, name: defaultLookName, own: false, mat: seaMat, styleColoured: false })
  const placeSea = () => {
    // The sea sits a hand's width above the DEM it lies on. Over open water a coastal site's DEM is
    // flat — there is no bathymetry to fetch — and it lands within a few centimetres of sea level,
    // so the plane and the terrain graze each other and the depth test fights: patches of flat
    // satellite-water win and the ripples blink out in hard-edged rectangles. glPolygonOffset
    // cannot fix it because the renderer's logarithmic depth buffer writes gl_FragDepth in the
    // shader, which disables polygon offset. A lift of a third of a metre clears the log-depth
    // quantum out to the horizon and is invisible at the waterline. (WATER_LEVEL_M stays the sea
    // level a game reasons about; this is a draw bias.)
    sea.position.set(0, T.WATER_LEVEL_M + SEA_DRAW_LIFT, 0)
    sea.scale.set(T.WATER_LEVEL_SPAN * 2, 1, T.WATER_LEVEL_SPAN * 2)
  }
  placeSea()
  const advance = (t: number) => {
    uniforms.uTime.value = t * T.WATER_SPEED
    uniforms.uWind.value.copy(waterWind())
    const k = knobs()
    const dflt = defaultLookOverride ?? defaultLookNameOf()
    for (const wm of waveMats) {
      const want = wm.own ? wm.name : dflt
      if (want !== wm.name) {
        wm.name = want
        wm.look = lookOf(want)
        applyLookColours(wm.u, wm.look)
        if (!wm.styleColoured) wm.mat.color.setHex(wm.look.colour)
      }
      refreshLook(wm.u, wm.look, k)
    }
    placeSea()
  }
  const streamMats: THREE.MeshStandardMaterial[] = []
  const stillMats: THREE.MeshStandardMaterial[] = []
  const applyTint = (m: THREE.MeshStandardMaterial) => {
    const wm = m.userData.water as { u: WaterWaveUniforms } | undefined
    if (wm) waterTints(m.color, wm.u.uShoreColor.value, wm.u.uDepthColor.value)
  }
  const setColours = (streamC: THREE.Color, stillC: THREE.Color, seaC: THREE.Color, opacityBias = 0) => {
    for (const wm of waveMats) wm.styleColoured = true
    seaMat.color.copy(seaC)
    seaMat.opacity = Math.min(0.98, T.WATER_OPACITY + 0.08 + opacityBias)
    for (const m of streamMats) { m.color.copy(streamC); m.opacity = Math.min(0.98, T.WATER_OPACITY + opacityBias) }
    for (const m of stillMats) { m.color.copy(stillC); m.opacity = Math.min(1, T.WATER_OPACITY + 0.05 + opacityBias) }
    applyTint(seaMat)
    for (const m of streamMats) applyTint(m)
    for (const m of stillMats) applyTint(m)
  }
  const setLook = (name: string | null) => { defaultLookOverride = name }
  const empty: WaterResult = { group, tick: advance, lines: 0, areas: 0, falls: 0, length_m: 0, setColours, setLook, looks: [] }
  if (!water || (!water.lines?.length && !water.areas?.length)) return empty

  const foam = foamMaterial(uniforms)
  let nLines = 0, nFalls = 0, length = 0
  const foamGeo: THREE.BufferGeometry[] = []

  // ONE MESH PER (LOOK, MATERIAL), not per waterway. The Crofton region has 416 streams, 129 rapids
  // and 199 ponds: drawn separately that is ~744 draw calls for about 4,000 triangles, which is the
  // wrong trade in every direction. Bodies naming the same `look` merge; nothing picks an individual
  // stream. The per-line records stay on the result for anyone who needs them.
  interface Bucket { look: WaterLook; lines: THREE.BufferGeometry[]; areas: THREE.BufferGeometry[] }
  const buckets = new Map<string, Bucket>()
  const bucketFor = (name: string | undefined): Bucket => {
    const key = name && WATER_LOOK_NAMES.includes(name) ? name : defaultLookName
    let b = buckets.get(key)
    if (!b) { b = { look: lookOf(key), lines: [], areas: [] }; buckets.set(key, b) }
    return b
  }

  for (const ln of water.lines ?? []) {
    if (ln.culvert || ln.pts.length < 2) continue
    const b = bucketFor(ln.look)
    const pts = ln.pts.map(([x, y, z]) => {
      const wz = -y
      const g = groundAt(x, wz)
      // the channel bottom plus the water's depth; never more than 0.3 m under the graded ground
      const surf = z + T.WATER_DEPTH
      return new THREE.Vector3(x, g === null ? surf : Math.max(surf, g - 0.3), wz)
    })
    const w = Math.max(0.6, ln.width_m) * T.WATER_WIDTH_SCALE
    b.lines.push(ribbon(pts, () => w, undefined, undefined, b.look.crown * T.WATER_CROWN))
    nLines++
    length += ln.length_m
    for (const f of ln.falls ?? []) {
      const seg = pts.slice(f.i0, f.i1 + 1).map((p) => p.clone().setY(p.y + 0.06))
      if (seg.length < 2) continue
      foamGeo.push(ribbon(seg, () => w * (f.kind === 'falls' ? 1.15 : 0.9), 'aFoam', () => 0.3))
      nFalls++
    }
  }
  const areaWind = waterWind()
  for (const ar of water.areas ?? []) {
    if (ar.ring.length < 3) continue
    const b = bucketFor(ar.look)
    const sh = new THREE.Shape(ar.ring.map(([x, y]) => new THREE.Vector2(x, y)))
    const geo = new THREE.ShapeGeometry(sh)
    // shape (x, y_site) → world (x, level, −y_site): rotate −90° about X puts local +Y on world −Z
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, ar.z + T.WATER_DEPTH * 0.5, 0)
    geo.deleteAttribute('normal')
    geo.computeVertexNormals()
    const depth = Math.max(0.3, b.look.pondDepth * T.WATER_CROWN)
    writeWaterAttr(geo, () => [depth, areaWind.x, areaWind.y])
    b.areas.push(geo)
  }

  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string) => {
    if (!geos.length) return
    // mergeGeometries needs identical attribute sets; ribbon() and ShapeGeometry both end up with
    // position + uv + normal + aWater, and the foam bucket additionally carries aFoam throughout.
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    if (!merged) {
      for (const g of geos) group.add(new THREE.Mesh(g, mat))  // mismatched attributes: draw them singly
      return
    }
    if (merged !== geos[0]) for (const g of geos) g.dispose()
    const mesh = new THREE.Mesh(merged, mat)
    mesh.name = name
    mesh.frustumCulled = false
    if (name === 'water:foam') mesh.renderOrder = 2
    group.add(mesh)
  }
  for (const [key, b] of buckets) {
    const own = key !== defaultLookName
    if (b.lines.length) {
      const m = makeMat(b.look, key, own)
      m.name = `water:streams:${key}`
      streamMats.push(m)
      add(b.lines, m, m.name)
    }
    if (b.areas.length) {
      const m = makeMat(b.look, key, own, 1.05)
      m.name = `water:areas:${key}`
      stillMats.push(m)
      add(b.areas, m, m.name)
    }
  }
  add(foamGeo, foam, 'water:foam')

  return { group, tick: advance, lines: nLines, areas: water.areas?.length ?? 0, falls: nFalls, length_m: Math.round(length), setColours, setLook, looks: [...buckets.keys()] }
}
