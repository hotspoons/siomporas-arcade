// Water: the streams, rivers, ponds and falls water.py measured (manifest.water), drawn where the
// lidar says the channel is.
//
//   lines   a ribbon per waterway, `width_m` wide, following the snapped points at the DTM low
//           line plus WATER_DEPTH (a stream is not a film on its bed). Culvert segments are not
//           drawn — the water goes under the road fill and comes out the other side.
//   areas   ponds/basins/wetlands as a flat polygon at the median ground inside them.
//   meshes  one per MATERIAL, not per waterway — a region can hold hundreds of streams (Crofton:
//           416 lines, 129 rapids, 199 ponds) and they share three materials between them.
//   falls   over a fall or rapid a second, brighter ribbon carries scrolling foam.
//   look    MeshStandardMaterial (so the log-depth and fog chunks come for free) with the normal
//           perturbed per frame by two scrolling value-noise layers over world position — the
//           cheap "animated normal" that reads as moving water from a car seat — low roughness,
//           a deep blue-green tint over the ground colour, slightly transparent so the bed shows.
//
// KNOWN GAP: within 0.6 m of any pavement the corridor strip sits at road height, so water under a
// bridge we are on is hidden by the strip deck until the strip learns to open over decks (main's).
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as T from './tuning'

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
}
export interface WaterArea { id: string; kind: string; name: string | null; area_m2: number; z: number; ring: [number, number][] }
export interface WaterLayer { lines: WaterLine[]; areas: WaterArea[]; summary?: Record<string, unknown> }

const GLSL_NOISE = /* glsl */ `
  float wh21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh21(i), wh21(i + vec2(1, 0)), u.x), mix(wh21(i + vec2(0, 1)), wh21(i + vec2(1, 1)), u.x), u.y);
  }
`

function waterMaterial(uniforms: { uTime: { value: number } }, colour: number, opacity: number, roughness: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: colour, roughness, metalness: 0.05, transparent: true, opacity, depthWrite: true, side: THREE.DoubleSide })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(position, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWaterPos;\n' + GLSL_NOISE)
      .replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>
        {
          // two scrolling ripple layers, finite-differenced into a normal perturbation
          vec2 p = vWaterPos.xz;
          float t = uTime;
          float e = 0.15;
          #define WAVE(q) (wnoise((q) * 1.7 + vec2(t * 0.35, t * 0.11)) * 0.6 + wnoise((q) * 4.3 - vec2(t * 0.22, -t * 0.4)) * 0.4)
          float h0 = WAVE(p);
          float hx = WAVE(p + vec2(e, 0.0));
          float hz = WAVE(p + vec2(0.0, e));
          vec3 pert = normalize(vec3(-(hx - h0) / e * 0.18, 1.0, -(hz - h0) / e * 0.18));
          normal = normalize(normal + (pert - vec3(0.0, 1.0, 0.0)) * 0.45);
        }
        `,
      )
  }
  mat.customProgramCacheKey = () => `corridor-water-${colour}`
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

/** a ribbon along world-frame points with per-point width; `uvAttr` names an optional (across, along) attribute */
function ribbon(points: THREE.Vector3[], width: (i: number) => number, uvAttr?: string): THREE.BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const dir = new THREE.Vector3()
  const side = new THREE.Vector3()
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)]
    dir.copy(b).sub(a).setY(0)
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0)
    dir.normalize()
    side.copy(dir).cross(up).multiplyScalar(width(i) / 2)
    const p = points[i]
    pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z)
    uv.push(0, i / Math.max(1, points.length - 1), 1, i / Math.max(1, points.length - 1))
    if (i > 0) {
      const k = (i - 1) * 2
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  if (uvAttr) g.setAttribute(uvAttr, new THREE.Float32BufferAttribute(uv, 2))
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
}

/**
 * Build the water. `groundAt(x, z)` is world-frame; used only to keep a ribbon from sinking under
 * the strip where the strip has re-graded the verge (the surface is max(channel, ground − 0.3)).
 */
export function buildWater(water: WaterLayer | null | undefined, groundAt: (x: number, z: number) => number | null): WaterResult {
  const group = new THREE.Group()
  group.name = 'water'
  const uniforms = { uTime: { value: 0 } }
  const empty = { group, tick: () => {}, lines: 0, areas: 0, falls: 0, length_m: 0 }
  if (!water || (!water.lines?.length && !water.areas?.length)) return empty
  const stream = waterMaterial(uniforms, 0x3d6b73, T.WATER_OPACITY, 0.28)
  const still = waterMaterial(uniforms, 0x46707a, Math.min(1, T.WATER_OPACITY + 0.05), 0.2)
  const foam = foamMaterial(uniforms)
  let nLines = 0, nFalls = 0, length = 0

  // ONE MESH PER MATERIAL, not per waterway. The Crofton region has 416 streams, 129 rapids and
  // 199 ponds: drawn separately that is ~744 draw calls for about 4,000 triangles, which is the
  // wrong trade in every direction. They share a material and nothing picks an individual stream,
  // so each bucket is merged. The per-line records stay on the result for anyone who needs them.
  const streamGeo: THREE.BufferGeometry[] = []
  const foamGeo: THREE.BufferGeometry[] = []
  const areaGeo: THREE.BufferGeometry[] = []

  for (const ln of water.lines ?? []) {
    if (ln.culvert || ln.pts.length < 2) continue
    const pts = ln.pts.map(([x, y, z]) => {
      const wz = -y
      const g = groundAt(x, wz)
      // the channel bottom plus the water's depth; never more than 0.3 m under the graded ground
      const surf = z + T.WATER_DEPTH
      return new THREE.Vector3(x, g === null ? surf : Math.max(surf, g - 0.3), wz)
    })
    const w = Math.max(0.6, ln.width_m) * T.WATER_WIDTH_SCALE
    streamGeo.push(ribbon(pts, () => w))
    nLines++
    length += ln.length_m
    for (const f of ln.falls ?? []) {
      const seg = pts.slice(f.i0, f.i1 + 1).map((p) => p.clone().setY(p.y + 0.06))
      if (seg.length < 2) continue
      foamGeo.push(ribbon(seg, () => w * (f.kind === 'falls' ? 1.15 : 0.9), 'aFoam'))
      nFalls++
    }
  }
  for (const ar of water.areas ?? []) {
    if (ar.ring.length < 3) continue
    const sh = new THREE.Shape(ar.ring.map(([x, y]) => new THREE.Vector2(x, y)))
    const geo = new THREE.ShapeGeometry(sh)
    // shape (x, y_site) → world (x, level, −y_site): rotate −90° about X puts local +Y on world −Z
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, ar.z + T.WATER_DEPTH * 0.5, 0)
    geo.deleteAttribute('normal')
    geo.computeVertexNormals()
    areaGeo.push(geo)
  }

  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string) => {
    if (!geos.length) return
    // mergeGeometries needs identical attribute sets; ribbon() and ShapeGeometry both end up with
    // position + uv + normal, and the foam bucket additionally carries aFoam throughout.
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
  add(streamGeo, stream, 'water:streams')
  add(areaGeo, still, 'water:areas')
  add(foamGeo, foam, 'water:foam')

  return { group, tick: (t) => { uniforms.uTime.value = t * T.WATER_SPEED }, lines: nLines, areas: water.areas?.length ?? 0, falls: nFalls, length_m: Math.round(length) }
}
