// Crop fields: corn, soy, small grain and stubble, drawn as ROWS.
//
// Rich, on the farm at the end of his neighbourhood: "I would love to be able to make polygons
// with those details and make fields of that stuff. These details, these are what you probably
// don't think that matter but that actually matter."
//
// A field does not read as a field because of its individual plants. It reads as a field because
// of the ROWS — their direction, their spacing, the dark furrow between them, and the way the
// whole pattern swings as you drive past it. So this is not the grass generator with a different
// texture. Each row is a ribbon: a vertical strip of foliage standing along the row line, plus a
// horizontal mat across its top so the field still reads from above and from far away, where the
// vertical strips turn edge-on and vanish. Two quads per segment, generated once, static.
//
// That geometry is a deliberate trade. Scattering individual plants at a real density — corn is
// about 0.76 m between rows and 0.18 m along them — puts 2.6 million plants in a 40 ha field, and
// no LOD scheme makes that cheap. A 500 m row is one ribbon of a hundred segments.
//
// SEASON drives crops harder than it drives anything else on the site. Corn in April is 0.3 m of
// wet green; in September it is 2.4 m of dry standing stalk with a tassel; by November it is
// stubble and the field is mostly bare soil. That is in CROPS below, per crop per season, and it
// is the whole reason a crop is a type rather than a texture.
import * as THREE from 'three'
import type { Season } from './season'
import * as T from './tuning'

export type CropType = 'corn' | 'soy' | 'wheat' | 'hay' | 'fallow'
export const CROP_TYPES: CropType[] = ['corn', 'soy', 'wheat', 'hay', 'fallow']

interface CropSeason {
  /** metres, the standing height of the crop in this season */
  height: number
  /** how much of the ground it covers, 0…1 — drives the top mat's opacity */
  cover: number
  base: THREE.Color
  tip: THREE.Color
}

export interface CropLook {
  /** metres between rows when nothing is authored */
  rowSpacing: number
  /** the row ribbon's width as a fraction of the spacing: how much bare furrow shows */
  fill: number
  winter: CropSeason
  spring: CropSeason
  summer: CropSeason
  autumn: CropSeason
}

const c = (hex: number) => new THREE.Color(hex)

/**
 * Maryland / mid-Atlantic planting, which is what every site baked so far sits in. `summer` is
 * September, like the rest of the palettes — corn is dry and standing, soy has turned, small
 * grain was cut in July and is stubble.
 */
export const CROPS: Record<CropType, CropLook> = {
  corn: {
    rowSpacing: 0.76, // the US standard row
    fill: 0.62,
    winter: { height: 0.25, cover: 0.3, base: c(0x6b5f42), tip: c(0x8d7f5c) },
    spring: { height: 0.35, cover: 0.35, base: c(0x4f8a34), tip: c(0x84c25a) },
    summer: { height: 2.4, cover: 0.95, base: c(0x5f6a30), tip: c(0xa89658) }, // September: dry, tasselled
    autumn: { height: 0.3, cover: 0.35, base: c(0x7d6f4c), tip: c(0xa8996c) }, // cut, stubble
  },
  soy: {
    rowSpacing: 0.38,
    fill: 0.78,
    winter: { height: 0.12, cover: 0.2, base: c(0x6a5f48), tip: c(0x877a5e) },
    spring: { height: 0.2, cover: 0.4, base: c(0x4c8a3a), tip: c(0x86c468) },
    summer: { height: 0.8, cover: 0.92, base: c(0x74793a), tip: c(0xb0a355) }, // September: turning
    autumn: { height: 0.15, cover: 0.25, base: c(0x776a4e), tip: c(0x9c8d68) },
  },
  wheat: {
    rowSpacing: 0.19,
    fill: 0.9,
    winter: { height: 0.15, cover: 0.5, base: c(0x4a7a3e), tip: c(0x76a862) },
    spring: { height: 0.5, cover: 0.85, base: c(0x5f9440), tip: c(0x9cc468) },
    summer: { height: 0.2, cover: 0.55, base: c(0xa2915c), tip: c(0xd3c189) }, // cut in July: stubble
    autumn: { height: 0.12, cover: 0.4, base: c(0x8a7d5c), tip: c(0xb4a684) },
  },
  hay: {
    rowSpacing: 0.3,
    fill: 0.95,
    winter: { height: 0.12, cover: 0.6, base: c(0x6f6a4a), tip: c(0x938d68) },
    spring: { height: 0.45, cover: 0.95, base: c(0x4f8f3a), tip: c(0x8cc45e) },
    summer: { height: 0.35, cover: 0.9, base: c(0x6f8a3e), tip: c(0xafb46a) },
    autumn: { height: 0.25, cover: 0.8, base: c(0x7f8450), tip: c(0xa8a878) },
  },
  fallow: {
    rowSpacing: 0.8,
    fill: 0.35,
    winter: { height: 0.08, cover: 0.15, base: c(0x5f5442), tip: c(0x7a6e58) },
    spring: { height: 0.25, cover: 0.5, base: c(0x5f7a42), tip: c(0x92a866) },
    summer: { height: 0.4, cover: 0.55, base: c(0x74784a), tip: c(0xa8a472) },
    autumn: { height: 0.2, cover: 0.3, base: c(0x6a6048), tip: c(0x8e8264) },
  },
}

/**
 * The side of a crop row, painted once to a canvas: stalks and leaves against transparency.
 * A PLACEHOLDER, like the forest floor — the real sets come from flux through gen.py. It is
 * built from the crop's own geometry (stalk pitch, leaf droop, tassel) rather than being one
 * generic mask, because corn and soy differ mostly in silhouette.
 */
export function cropTexture(type: CropType, size = 512): THREE.Texture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  let seed = 1009 + CROP_TYPES.indexOf(type) * 7717
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const G = size // ground at the bottom of the canvas
  const plants = type === 'corn' ? 26 : type === 'soy' ? 70 : 150
  for (let i = 0; i < plants; i++) {
    const x = rnd() * size
    const h = size * (type === 'corn' ? 0.72 + rnd() * 0.26 : type === 'soy' ? 0.55 + rnd() * 0.4 : 0.6 + rnd() * 0.38)
    const shade = 0.6 + rnd() * 0.55
    const g = (v: number) => Math.max(0, Math.min(255, v * shade)) | 0
    if (type === 'corn') {
      // a stalk with leaves arching off it both ways, and a tassel on top
      ctx.strokeStyle = `rgba(${g(150)},${g(148)},${g(74)},1)`
      ctx.lineWidth = 3.5 + rnd() * 2
      ctx.beginPath()
      ctx.moveTo(x, G)
      ctx.quadraticCurveTo(x + (rnd() - 0.5) * 14, G - h * 0.6, x + (rnd() - 0.5) * 22, G - h)
      ctx.stroke()
      for (let l = 0; l < 6; l++) {
        const ly = G - h * (0.25 + 0.11 * l)
        const dir = l % 2 ? 1 : -1
        const span = (size * 0.045) * (1.4 - l * 0.12) * (0.7 + rnd() * 0.6)
        ctx.strokeStyle = `rgba(${g(138)},${g(150)},${g(66)},1)`
        ctx.lineWidth = 2.5 + rnd() * 2.5
        ctx.beginPath()
        ctx.moveTo(x, ly)
        ctx.quadraticCurveTo(x + dir * span * 0.7, ly - span * 0.35, x + dir * span, ly + span * 0.45)
        ctx.stroke()
      }
      ctx.strokeStyle = `rgba(${g(186)},${g(168)},${g(96)},1)`
      ctx.lineWidth = 1.6
      for (let t = 0; t < 4; t++) {
        ctx.beginPath()
        ctx.moveTo(x, G - h)
        ctx.lineTo(x + (rnd() - 0.5) * 18, G - h - 8 - rnd() * 16)
        ctx.stroke()
      }
    } else {
      // a bush: a mound of small leaves
      const leaves = type === 'soy' ? 26 : 12
      for (let l = 0; l < leaves; l++) {
        const ly = G - rnd() * h
        const lx = x + (rnd() - 0.5) * size * 0.035
        ctx.fillStyle = `rgba(${g(126)},${g(142)},${g(60)},1)`
        ctx.beginPath()
        ctx.ellipse(lx, ly, 3 + rnd() * 5, 2 + rnd() * 3.5, rnd() * 3.14, 0, 6.2832)
        ctx.fill()
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  return tex
}

export interface Field {
  polygon: [number, number][] // site frame (x east, y north)
  crop: CropType
  /** compass bearing the rows run along */
  headingDeg: number
  /** metres between rows; 0 = the crop's own default */
  spacing: number
}

const GLSL_GRADE = /* glsl */ `
  vec3 gradeCrop(vec3 base, vec3 tip, float t, float rnd) {
    // the base has to hold well up the stalk: a September corn field is dry at the top and still
    // green-brown at knee height, and a ramp that reaches the tip colour by halfway turns the
    // whole field one flat acid yellow
    vec3 col = mix(base, tip, smoothstep(0.3, 1.0, t));
    return col * (0.74 + 0.5 * rnd);
  }
`

/**
 * Build every field into one mesh per crop type (one draw call each).
 *
 * Rows are laid on a lattice rotated to the field's heading and clipped to the polygon by a
 * scanline: project the polygon onto the across-row axis, walk it in `spacing` steps, and for each
 * step intersect the row line with every edge. The spans that come back are the runs of crop, and
 * a run becomes a ribbon of segments short enough to follow the ground.
 */
export function buildCrops(
  fields: Field[],
  season: Season,
  groundAt: (x: number, z: number) => number | null,
  edgeDistance: (x: number, z: number) => number,
): { group: THREE.Group; counts: Record<string, number>; setSeason: (s: Season) => void } {
  const group = new THREE.Group()
  group.name = 'crops'
  const counts: Record<string, number> = {}
  const meshes: THREE.Mesh[] = []
  const byCrop = new Map<CropType, Field[]>()
  for (const f of fields) {
    if (!byCrop.has(f.crop)) byCrop.set(f.crop, [])
    byCrop.get(f.crop)!.push(f)
  }

  for (const [crop, list] of byCrop) {
    const look = CROPS[crop]
    const pos: number[] = []
    const uv: number[] = []
    const aInfo: number[] = [] // (heightFrac, rnd, isMat)
    const idx: number[] = []
    let rows = 0

    for (const f of list) {
      const spacing = Math.max(0.12, (f.spacing || look.rowSpacing) * T.CROP_ROW_SCALE)
      // compass bearing → a direction in the SITE frame (x east, y north)
      const th = (f.headingDeg * Math.PI) / 180
      const ux = Math.sin(th), uy = Math.cos(th) // along the rows
      const vx = uy, vy = -ux // across them
      let v0 = Infinity, v1 = -Infinity
      for (const [px, py] of f.polygon) {
        const v = px * vx + py * vy
        if (v < v0) v0 = v
        if (v > v1) v1 = v
      }
      for (let v = Math.ceil(v0 / spacing) * spacing; v <= v1; v += spacing) {
        // scanline: where this row line crosses the polygon
        const hits: number[] = []
        for (let i = 0, j = f.polygon.length - 1; i < f.polygon.length; j = i++) {
          const [ax, ay] = f.polygon[j], [bx, by] = f.polygon[i]
          const va = ax * vx + ay * vy, vb = bx * vx + by * vy
          if (va > v === vb > v) continue
          const t = (v - va) / (vb - va)
          hits.push((ax + (bx - ax) * t) * ux + (ay + (by - ay) * t) * uy)
        }
        hits.sort((a, b) => a - b)
        for (let h = 0; h + 1 < hits.length; h += 2) emitRow(hits[h], hits[h + 1], v)
      }

      function emitRow(uA: number, uB: number, v: number) {
        if (uB - uA < 1.5) return
        rows++
        const seg = T.CROP_SEGMENT_M
        const rnd = hash(Math.round(v * 37) + Math.round(uA * 11))
        const halfW = spacing * look.fill * 0.5
        let prev: { x: number; z: number; y: number } | null = null
        for (let u = uA; u <= uB + 1e-6; u += seg) {
          const uu = Math.min(u, uB)
          const sx = ux * uu + vx * v, sy = uy * uu + vy * v // site frame
          const x = sx, z = -sy // world frame
          const y = groundAt(x, z)
          // off the field: the road, or ground the strip does not know about
          if (y === null || edgeDistance(x, z) < T.CROP_MIN_FROM_ROAD) { prev = null; continue }
          const here = { x, z, y }
          if (prev) {
            const base = pos.length / 3
            // the standing ribbon, along the row
            pos.push(prev.x, prev.y, prev.z, here.x, here.y, here.z, here.x, here.y + 1, here.z, prev.x, prev.y + 1, prev.z)
            const uvLen = Math.hypot(here.x - prev.x, here.z - prev.z) / Math.max(0.5, T.CROP_TEXTURE_M)
            uv.push(0, 0, uvLen, 0, uvLen, 1, 0, 1)
            for (let q = 0; q < 4; q++) aInfo.push(q < 2 ? 0 : 1, rnd, 0)
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
            // the mat across the top, so the field still reads from above and from a long way off
            const dx = here.x - prev.x, dz = here.z - prev.z
            const l = Math.max(1e-4, Math.hypot(dx, dz))
            const nx = (-dz / l) * halfW, nz = (dx / l) * halfW
            const m = pos.length / 3
            pos.push(prev.x - nx, prev.y + 0.92, prev.z - nz, here.x - nx, here.y + 0.92, here.z - nz, here.x + nx, here.y + 0.92, here.z + nz, prev.x + nx, prev.y + 0.92, prev.z + nz)
            uv.push(0, 0, uvLen, 0, uvLen, 1, 0, 1)
            for (let q = 0; q < 4; q++) aInfo.push(1, rnd, 1)
            idx.push(m, m + 1, m + 2, m, m + 2, m + 3)
          }
          prev = here
          if (uu >= uB) break
        }
      }
    }

    if (!pos.length) continue
    counts[crop] = rows
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(aInfo, 3))
    geo.setIndex(idx)
    geo.computeBoundingSphere()

    const look0 = look[season]
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        // `fog: true` alone is not enough: three's fog chunk reads fogColor and fogDensity out of
        // THIS material's uniforms, and a ShaderMaterial does not inherit them. Without the merge
        // the first render throws inside refreshFogUniforms and the whole load fails.
        ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        uMap: { value: cropTexture(crop) },
        uBase: { value: look0.base.clone() },
        uTip: { value: look0.tip.clone() },
        uHeight: { value: look0.height },
        uCover: { value: look0.cover },
        uTime: { value: 0 },
        uWind: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aInfo; // heightFrac, rnd, isMat
        uniform float uHeight;
        uniform float uTime;
        uniform float uWind;
        varying vec2 vUv;
        varying float vT;
        varying float vRnd;
        varying float vMat;
        #include <common>
        #include <fog_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vUv = uv;
          vT = aInfo.x;
          vRnd = aInfo.y;
          vMat = aInfo.z;
          // the unit ribbon is built one metre tall and scaled here, so a season change is a
          // uniform and never a rebuild
          vec3 p = position;
          float lift = aInfo.z > 0.5 ? 0.92 : aInfo.x;
          p.y = position.y - lift + lift * uHeight;
          // wind: the whole row leans together, which is what a crop does — a corn field moves in
          // sheets, not blade by blade
          float sway = sin(uTime * 0.8 + p.x * 0.05 + p.z * 0.04) * 0.10
                     + sin(uTime * 1.7 + p.x * 0.11) * 0.04;
          p.xz += vec2(0.8, 0.5) * sway * uWind * lift * uHeight;
          // three's fog chunk reads a variable named exactly mvPosition; calling it anything else
          // compiles clean here and then fails inside the fog include
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uBase;
        uniform vec3 uTip;
        uniform float uCover;
        varying vec2 vUv;
        varying float vT;
        varying float vRnd;
        varying float vMat;
        #include <fog_pars_fragment>
        #include <logdepthbuf_pars_fragment>
        ${GLSL_GRADE}
        void main() {
          #include <logdepthbuf_fragment>
          float a = 1.0;
          float t = vT;
          if (vMat < 0.5) {
            // the standing ribbon carries the plant silhouette
            a = texture2D(uMap, vec2(vUv.x, vUv.y)).a;
            if (a < 0.4) discard;
          } else {
            // the top mat: thinner where the crop does not close over, and never a hard edge
            if (uCover < 0.99 && fract(sin(vUv.x * 91.7 + vUv.y * 47.3) * 43758.5453) > uCover) discard;
            t = 1.0;
          }
          vec3 col = gradeCrop(uBase, uTip, t, vRnd);
          // the furrow: the bottom of a row is in its own shadow
          col *= mix(0.55, 1.0, smoothstep(0.0, 0.45, vT));
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      fog: true,
    })
    const mesh = new THREE.Mesh(geo, mat)
    meshes.push(mesh)
    mesh.name = `crop-${crop}`
    mesh.frustumCulled = false
    mesh.userData.crop = crop
    group.add(mesh)
  }

  return {
    group,
    counts,
    setSeason: (s: Season) => {
      // the ribbon is built one metre tall, so a season is four uniforms and never a rebuild —
      // corn goes from 0.35 m in April to 2.4 m in September without touching a vertex
      for (const mesh of meshes) {
        const l = CROPS[mesh.userData.crop as CropType][s]
        const m = mesh.material as THREE.ShaderMaterial
        ;(m.uniforms.uBase.value as THREE.Color).copy(l.base)
        ;(m.uniforms.uTip.value as THREE.Color).copy(l.tip)
        m.uniforms.uHeight.value = l.height
        m.uniforms.uCover.value = l.cover
      }
    },
  }
}

/** Advance the wind. */
export function tickCrops(group: THREE.Group, time: number) {
  for (const ch of group.children) {
    const m = (ch as THREE.Mesh).material as THREE.ShaderMaterial
    if (m?.uniforms?.uTime) {
      m.uniforms.uTime.value = time
      m.uniforms.uWind.value = T.CROP_WIND
    }
  }
}

function hash(n: number): number {
  let x = (n | 0) ^ 0x5bd1e995
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d)
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39)
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296
}
