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
import type { TreeRecord } from './trees'

export const LANE_M = 3.66 // US interstate lane
export const SHOULDER_OUT_M = 3.0
export const SHOULDER_IN_M = 1.2

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

/** Width of the paved surface at station s: lanes × 3.66 + both shoulders. */
export function pavedWidth(lanes: number): number {
  return lanes * LANE_M + SHOULDER_OUT_M + SHOULDER_IN_M
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
}

export function roadMesh(st: Station[], lanesAt: (s: number) => number, classAt: (s: number) => string = () => 'asphalt_aged', sets: Record<string, SurfaceSet> = {}, lift = 0.15): THREE.Group {
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

  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1]
    const la = lanesAt(a.s), lb = lanesAt(b.s)
    const wa = pavedWidth(la), wb = pavedWidth(lb)
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
    quad(bk.pos, bk.idx, P(a.pos, sa, -wa / 2, ya), P(a.pos, sa, wa / 2, ya), P(b.pos, sb, -wb / 2, yb), P(b.pos, sb, wb / 2, yb), undefined, undefined,
      [0, a.s / mpt, wa / mpt, a.s / mpt, 0, b.s / mpt, wb / mpt, b.s / mpt], bk.uv)
    // edge lines: yellow left (median side), white right, sitting on the shoulder boundary
    const ml = 0.12, y2a = ya + 0.02, y2b = yb + 0.02
    const leftA = -wa / 2 + SHOULDER_IN_M, leftB = -wb / 2 + SHOULDER_IN_M
    const rightA = wa / 2 - SHOULDER_OUT_M, rightB = wb / 2 - SHOULDER_OUT_M
    quad(marks, midx, P(a.pos, sa, leftA - ml, y2a), P(a.pos, sa, leftA + ml, y2a), P(b.pos, sb, leftB - ml, y2b), P(b.pos, sb, leftB + ml, y2b), yellow, mcol)
    quad(marks, midx, P(a.pos, sa, rightA - ml, y2a), P(a.pos, sa, rightA + ml, y2a), P(b.pos, sb, rightB - ml, y2b), P(b.pos, sb, rightB + ml, y2b), white, mcol)
    // lane dashes: 3 m paint / 9 m gap is the US standard; one dash per 12 m station cycle
    const cycle = Math.floor(a.s / 12) * 12
    if (a.s - cycle < 3.01 && la === lb) {
      const len = Math.min(3, b.s - a.s)
      const bb = a.pos.clone().add(a.dir.clone().multiplyScalar(len))
      for (let l = 1; l < la; l++) {
        const off = leftA + l * LANE_M
        quad(marks, midx, P(a.pos, sa, off - 0.08, y2a), P(a.pos, sa, off + 0.08, y2a), P(bb, sa, off - 0.08, y2a), P(bb, sa, off + 0.08, y2a), white, mcol)
      }
    }
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
  g.add(new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })))
  return g
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
  const { HEX_GLSL, arrayTexture } = await import('./hextile')
  const normalChunk = THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'vec3 mapN = hexN;')
  for (const s of cat.sets) {
    // variant 0 stays on the material so three enables USE_MAP / USE_NORMALMAP and the uv varyings
    const mat = new THREE.MeshStandardMaterial({ map: tex(s.albedo, true), normalMap: tex(s.normal, false), normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: tex(s.roughness, false), roughness: 1, metalness: 0, side: THREE.DoubleSide })
    const variants = s.variants && s.variants.length > 1 ? s.variants : null
    if (variants) {
      const [albedo, normal] = await Promise.all([arrayTexture(variants.map((v) => `/${v.albedo}`), true), arrayTexture(variants.map((v) => `/${v.normal}`), false)])
      const macro = s.macro ? tex(s.macro, true) : null
      if (macro) macro.wrapS = macro.wrapT = THREE.MirroredRepeatWrapping
      const ratio = (s.macro_metres ?? 8) / s.metres_per_tile
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
    out[s.name] = { name: s.name, metresPerTile: s.metres_per_tile, material: mat }
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
