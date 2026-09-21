// Build a three.js scene from a site manifest. World frame: X = east, Y = up (metres NAVD88),
// Z = south — i.e. (x, y, z)_site -> (x, z, -y)_three, right-handed with Y up so nothing in
// three's camera/controls code has to be told about Z-up.
import * as THREE from 'three'
import { DATA_BASE, decodeHeights, decodeScalar, loadImage, type Layer, type Manifest, type Structure } from './site'
import { NearTrees } from './trees'
import { Impostors } from './impostors'
import { Grass } from './grass'
import { LOOK, type Season } from './season'
import { buildStrip, sinkUnderStrip } from './strip'
import { Adjustments, NEUTRAL as NEUTRAL_ADJ } from './adjust'
import { buildPlacements, loadCatalog, loadPlacements } from './placements'
import { loadSurfaceSets, overpassMesh, pavedWidth, roadMesh, stations, treesFromCanopy, type SurfaceSet } from './props'

let surfaceSets: Record<string, SurfaceSet> | null = null

export const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

export interface Site {
  manifest: Manifest
  group: THREE.Group
  layers: { imagery?: THREE.Mesh; canopy?: THREE.Mesh; trees?: THREE.Group; road: THREE.Group; horizon?: THREE.Mesh; structures: THREE.Group; spine: THREE.Group; markers: THREE.Group; placements: THREE.Group }
  adjustments: Adjustments
  treeCount: number
  /** per-frame: move the near-field tree models and the grass ring to follow the eye */
  updateNear: (eye: THREE.Vector3, time: number) => void
  /** recolour everything living */
  setSeason: (season: Season) => void
  /** world-frame ground height under x,z: the fine strip near the road, the DEM beyond */
  groundAt: (x: number, z: number) => number | null
  /** signed distance to the nearest pavement edge (negative on the pavement) */
  edgeDistance: (x: number, z: number) => number
  /** trees within r of world x,z as [x, z, trunkRadius] */
  treesNear: (x: number, z: number, r: number) => [number, number, number][]
  terrain: THREE.Mesh
  /** ground height (m) at site x,y from the DEM layer */
  heightAt: (x: number, y: number) => number
  /** point + travel direction on the spine at along-track s (metres) */
  spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }
  /** the terrain's texture, so the imagery toggle can swap it in and out */
  setImagery: (on: boolean) => void
  /** draw the terrain as a wireframe */
  setWire: (on: boolean) => void
}

interface Field {
  layer: Layer
  data: Float32Array
}

function sampler(f: Field) {
  const [xmin, , , ymax] = f.layer.bbox
  const [w, h] = f.layer.size
  return (x: number, y: number) => {
    const c = Math.min(w - 1, Math.max(0, Math.floor((x - xmin) / f.layer.res)))
    const r = Math.min(h - 1, Math.max(0, Math.floor((ymax - y) / f.layer.res)))
    return f.data[r * w + c]
  }
}

/** A regular grid mesh over a height field, sampled every `stride` cells. */
function gridGeometry(f: Field, stride: number, lift: (i: number, r: number, c: number) => number, color?: (i: number) => [number, number, number]) {
  const [xmin, , , ymax] = f.layer.bbox
  const [w, h] = f.layer.size
  const cols = Math.floor((w - 1) / stride) + 1
  const rows = Math.floor((h - 1) / stride) + 1
  const pos = new Float32Array(cols * rows * 3)
  const uv = new Float32Array(cols * rows * 2)
  const col = color ? new Float32Array(cols * rows * 3) : null
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rr = Math.min(h - 1, r * stride)
      const cc = Math.min(w - 1, c * stride)
      const i = rr * w + cc
      const x = xmin + (cc + 0.5) * f.layer.res
      const y = ymax - (rr + 0.5) * f.layer.res
      pos[k * 3] = x
      pos[k * 3 + 1] = f.data[i] + lift(i, rr, cc)
      pos[k * 3 + 2] = -y
      uv[k * 2] = (cc + 0.5) / w
      uv[k * 2 + 1] = 1 - (rr + 0.5) / h
      if (col && color) {
        const [cr, cg, cb] = color(i)
        col[k * 3] = cr
        col[k * 3 + 1] = cg
        col[k * 3 + 2] = cb
      }
      k++
    }
  }
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6)
  let n = 0
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      const b = a + 1
      const d = a + cols
      const e = d + 1
      idx[n++] = a; idx[n++] = d; idx[n++] = b
      idx[n++] = b; idx[n++] = d; idx[n++] = e
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeVertexNormals()
  return g
}

/** Pick a stride so a grid stays under `maxVerts` vertices. */
const strideFor = (layer: Layer, maxVerts: number) => Math.max(1, Math.ceil(Math.sqrt((layer.size[0] * layer.size[1]) / maxVerts)))

function ribbon(points: THREE.Vector3[], width: number, color: number, opacity = 1) {
  const pos: number[] = []
  const idx: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)]
    const b = points[Math.min(points.length - 1, i + 1)]
    const dir = b.clone().sub(a).setY(0).normalize()
    const side = dir.clone().cross(up).multiplyScalar(width / 2)
    const p = points[i]
    pos.push(p.x - side.x, p.y, p.z - side.z, p.x + side.x, p.y, p.z + side.z)
    if (i > 0) {
      const k = (i - 1) * 2
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  const m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 })
  return new THREE.Mesh(g, m)
}

const hypso = (z: number): [number, number, number] => {
  // piedmont palette: valley green -> ridge brown -> grey summits, for the far terrain when no imagery
  const t = Math.min(1, Math.max(0, (z - 60) / 600))
  const lo = [0.36, 0.48, 0.3], mid = [0.5, 0.44, 0.3], hi = [0.55, 0.55, 0.52]
  const [a, b, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, hi, (t - 0.5) * 2]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}


export async function buildSite(manifest: Manifest, status: (s: string) => void, lite = false, renderer?: THREE.WebGLRenderer, fog: THREE.FogExp2 | null = null, initialSeason: Season = 'summer'): Promise<Site> {
  const base = `/sites/${manifest.slug}/web/`
  const group = new THREE.Group()
  const L = manifest.layers
  if (!L.dem) throw new Error('site has no DEM layer')

  status('decoding terrain…')
  const adjustments = await Adjustments.load(manifest.slug)
  const demImg = await loadImage(base + L.dem.file)
  const dem: Field = { layer: L.dem, data: decodeHeights(demImg, L.dem) }
  const heightAt = sampler(dem)

  // --- near terrain, textured with the imagery -----------------------------------------------
  const stride = strideFor(L.dem, lite ? 300_000 : 1_100_000)
  const terrainGeo = gridGeometry(dem, stride, () => 0)
  let imagery: THREE.Texture | null = null
  if (L.naip) {
    status('loading imagery…')
    let tex: THREE.Texture
    if (lite) {
      // a phone GPU gets the imagery redrawn to at most 4096 px on the long side
      const img = await loadImage(base + L.naip.file)
      const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.round(img.naturalWidth * k)
      c.height = Math.round(img.naturalHeight * k)
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      tex = new THREE.CanvasTexture(c)
    } else {
      tex = new THREE.TextureLoader().load(`${DATA_BASE}${base}${L.naip.file}`)
    }
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = lite ? 2 : 8
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    imagery = tex
  }
  const bare = new THREE.Color(0x6f6a5a)
  const terrainMat = new THREE.MeshStandardMaterial({ map: imagery, color: imagery ? 0xffffff : bare, roughness: 1, metalness: 0 })
  const terrain = new THREE.Mesh(terrainGeo, terrainMat)
  terrain.name = 'terrain'
  group.add(terrain)

  // --- canopy: the forest blanket (off by default; the trees below are the stand-ins) --------
  let canopy: THREE.Mesh | undefined
  let chm: Field | undefined
  if (L.chm) {
    status('decoding canopy…')
    const chmImg = await loadImage(base + L.chm.file)
    chm = { layer: L.chm, data: decodeScalar(chmImg, L.chm.scale ?? 0.25) }
    if (adjustments.active) {
      // bake the human's canopy corrections into the height model once: scale and offset per cell
      const [w, h] = chm.layer.size
      const [xmin, , , ymax] = chm.layer.bbox
      const res = chm.layer.res
      const adj = { ...NEUTRAL_ADJ }
      let touched = 0
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const i = r * w + c
          if (chm.data[i] <= 0) continue
          adjustments.at(xmin + (c + 0.5) * res, ymax - (r + 0.5) * res, adj)
          if (adj.canopy_scale !== 1 || adj.canopy_offset_m !== 0) {
            chm.data[i] = Math.max(0, chm.data[i] * adj.canopy_scale + adj.canopy_offset_m)
            touched++
          }
        }
      }
      if (touched) console.info(`adjustments: canopy changed in ${touched} cells`)
    }
    const alpha = new THREE.Texture(chmImg)
    alpha.needsUpdate = true
    alpha.flipY = true
    const cd = chm.data
    const geo = gridGeometry(dem, stride, (i) => (cd[i] > 1.5 ? cd[i] : 0), (i) => {
      const t = Math.min(1, cd[i] / 30)
      return [0.24 - 0.1 * t, 0.5 - 0.22 * t, 0.2 - 0.09 * t]
    })
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, alphaMap: alpha, alphaTest: 0.03, roughness: 1, side: THREE.DoubleSide })
    canopy = new THREE.Mesh(geo, mat)
    canopy.name = 'canopy'
    canopy.visible = false
    group.add(canopy)
  }

  // --- far terrain -----------------------------------------------------------------------------
  let horizon: THREE.Mesh | undefined
  if (L.horizon) {
    status('decoding horizon…')
    const hImg = await loadImage(base + L.horizon.file)
    const hz: Field = { layer: L.horizon, data: decodeHeights(hImg, L.horizon) }
    const hs = strideFor(L.horizon, lite ? 120_000 : 300_000)
    const geo = gridGeometry(hz, hs, () => -2.0, L.horizon_naip ? undefined : (i) => hypso(hz.data[i]))
    let mat: THREE.Material
    if (L.horizon_naip) {
      const tex = new THREE.TextureLoader().load(`${DATA_BASE}${base}${L.horizon_naip.file}`)
      tex.colorSpace = THREE.SRGBColorSpace
      mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })
    } else {
      mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })
    }
    horizon = new THREE.Mesh(geo, mat)
    horizon.name = 'horizon'
    group.add(horizon)
  }

  // --- the spine, its siblings, and along-track lookup --------------------------------------
  // ONE smooth curve for everything that follows the road — pavement, paint, grading, the driver's
  // eye. A polyline through OSM nodes gives angular paint and a camera that snaps at every node;
  // a centripetal Catmull-Rom through the 10 m densified spine does not overshoot and is C1.
  const raw = manifest.spine.coords.map(([x, y, z]) => toWorld(x, y, z + 0.4))
  const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal')
  curve.arcLengthDivisions = Math.max(200, raw.length * 8)
  const curveLen = curve.getLength()
  const sp = curve.getSpacedPoints(Math.max(2, Math.round(curveLen / 6)))
  const spineAt = (s: number) => {
    const u = Math.min(1, Math.max(0, s / curveLen))
    const pos = curve.getPointAt(u)
    const dir = curve.getTangentAt(u)
    return { pos, dir }
  }
  const spine = new THREE.Group()
  spine.name = 'spine'
  // analysis overlay: a thin centreline, floating a hand above the pavement so it never floods it
  spine.add(ribbon(sp.map((v) => v.clone().add(new THREE.Vector3(0, 0.5, 0))), 0.35, 0xffdc00))
  for (const sib of manifest.siblings) {
    const pts = sib.map(([x, y]) => toWorld(x, y, heightAt(x, y) + 0.9))
    spine.add(ribbon(pts, 0.3, 0xff8c00, 0.9))
  }

  // --- the road surface, as wide as OSM says ---------------------------------------------------
  status('paving…')
  const segs = manifest.spine.segments
  const lanesAt = (s: number) => {
    const seg = segs.find((g) => g.s_start - 0.5 <= s && s <= g.s_end + 0.5)
    const n = Number(seg?.tags.lanes)
    return Number.isFinite(n) && n > 0 ? n : 2
  }
  const road = new THREE.Group()
  road.name = 'road'
  surfaceSets ??= await loadSurfaceSets()
  const surf = manifest.surface
  const adjScratch = { ...NEUTRAL_ADJ }
  const classAt = (s: number) => {
    if (adjustments.active) {
      const p = spineAt(s).pos
      const a = adjustments.at(p.x, -p.z, adjScratch)
      if (a.surface_class) return a.surface_class
    }
    if (!surf) return 'asphalt_aged'
    const i = Math.min(surf.class.length - 1, Math.max(0, Math.floor(s / surf.step_m)))
    return surf.class[i] ?? 'asphalt_aged'
  }
  const mainSt = stations(spineAt, manifest.spine.length_m, 6)
  road.add(roadMesh(mainSt, lanesAt, classAt, surfaceSets))
  // spine stations every 5 m, for "what is the road doing next to this point" lookups
  const spineSt: { x: number; z: number; y: number; s: number }[] = []
  for (let s = 0; s <= curveLen; s += 5) {
    const p = spineAt(s).pos
    spineSt.push({ x: p.x, z: p.z, y: p.y, s })
  }
  const nearestSpine = (x: number, z: number) => {
    let best = Infinity, bi = 0
    for (let i = 0; i < spineSt.length; i += 10) {
      const d = (spineSt[i].x - x) ** 2 + (spineSt[i].z - z) ** 2
      if (d < best) { best = d; bi = i }
    }
    for (let i = Math.max(0, bi - 10); i <= Math.min(spineSt.length - 1, bi + 10); i++) {
      const d = (spineSt[i].x - x) ** 2 + (spineSt[i].z - z) ** 2
      if (d < best) { best = d; bi = i }
    }
    return { ...spineSt[bi], dist: Math.sqrt(best) }
  }
  // the other carriageway of a divided highway shares the spine's grade — including its bridge
  // decks, which the lidar profile measured on OUR lanes only. Within 60 m laterally the sibling
  // takes the spine's road height (plus 0.4 m like the spine); further out it is its own road on
  // the DEM (a ramp peeling away, a frontage road).
  const sibAts: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number; spineS: (s: number) => number }[] = []
  for (const sib of manifest.siblings) {
    if (sib.length < 2) continue
    const raw2 = sib.map(([x, y]) => {
      const wz = -y
      const n = nearestSpine(x, wz)
      const z = n.dist < 60 ? n.y : heightAt(x, y) + 0.4
      return new THREE.Vector3(x, z, wz)
    })
    const c2 = new THREE.CatmullRomCurve3(raw2, false, 'centripetal')
    c2.arcLengthDivisions = Math.max(100, raw2.length * 8)
    const len2 = c2.getLength()
    const sibAt = (s: number) => {
      const u = Math.min(1, Math.max(0, s / len2))
      return { pos: c2.getPointAt(u), dir: c2.getTangentAt(u) }
    }
    sibAts.push({ at: sibAt, len: len2, spineS: (s: number) => { const p = sibAt(s).pos; return nearestSpine(p.x, p.z).s } })
    road.add(roadMesh(stations(sibAt, len2, 6), () => 2, () => 'asphalt_aged', surfaceSets))
  }

  // --- trees, one per canopy cell, as tall as the lidar says ---------------------------------
  let trees: THREE.Group | undefined
  let treeCount = 0
  let updateNear: (eye: THREE.Vector3, time: number) => void = () => {}
  let setSeason: (season: Season) => void = () => {}
  let groundAtWorld: (x: number, z: number) => number | null = (x, z) => heightAt(x, -z)
  let edgeDistanceWorld: (x: number, z: number) => number = () => Infinity
  let treesNearWorld: (x: number, z: number, r: number) => [number, number, number][] = () => []
  let currentSeason: Season = initialSeason
  if (chm) {
    // distance to the nearest PAVEMENT EDGE of any carriageway (negative = on the pavement):
    // stations every 5 m from the spine and every sibling, hashed on a 20 m grid with each
    // station carrying its own half width. Grass, verges and tree exclusion all ask this.
    const stCell = 20
    const stGrid = new Map<string, { x: number; z: number; y: number; half: number; who: number }[]>()
    const addStations = (at: (s: number) => { pos: THREE.Vector3 }, len: number, halfAt: (s: number) => number, who: number) => {
      for (let s = 0; s <= len; s += 5) {
        const p = at(s).pos
        const k = `${Math.floor(p.x / stCell)},${Math.floor(p.z / stCell)}`
        const arr = stGrid.get(k)
        const rec = { x: p.x, z: p.z, y: p.y, half: halfAt(s), who }
        if (arr) arr.push(rec)
        else stGrid.set(k, [rec])
      }
    }
    addStations(spineAt, curveLen, (s) => pavedWidth(lanesAt(s)) / 2, 0)
    for (const [i, sib] of sibAts.entries()) addStations(sib.at, sib.len, () => pavedWidth(2) / 2, i + 1)
    /** signed distance to the nearest pavement edge, and which carriageway that was */
    const edgeDistance = (x: number, z: number, exclude = -1): { d: number; who: number; y: number } => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      let best = Infinity, who = -1, y = 0
      for (let a = -3; a <= 3; a++) {
        for (let b = -3; b <= 3; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            if (p.who === exclude) continue
            const d = Math.hypot(p.x - x, p.z - z) - p.half
            if (d < best) { best = d; who = p.who; y = p.y }
          }
        }
      }
      return { d: best, who, y }
    }
    const roadDistance = (x: number, z: number) => edgeDistance(x, z).d

    // --- the corridor strip: fine terrain across every carriageway and 40 m of verge each side ---
    status('grading…')
    let latMin = 0, latMax = 0
    for (const sib of sibAts) {
      for (let s = 0; s <= sib.len; s += 50) {
        const p = sib.at(s).pos
        const n = nearestSpine(p.x, p.z)
        if (n.dist > 120) continue
        const st = spineAt(n.s)
        const side = st.dir.clone().setY(0).normalize().cross(new THREE.Vector3(0, 1, 0))
        const lat = (p.x - st.pos.x) * side.x + (p.z - st.pos.z) * side.z
        latMin = Math.min(latMin, lat)
        latMax = Math.max(latMax, lat)
      }
    }
    const VERGE = 40
    const grassTex = (cls: string) => ((surfaceSets?.[cls]?.material as THREE.MeshStandardMaterial | undefined)?.map ?? null)
    const strip = buildStrip(spineAt, curveLen, -latMin + VERGE, latMax + VERGE, (x, z) => edgeDistance(x, z), heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 2, lite ? 2 : 1, adjustments.active ? (x, y) => adjustments.at(x, y, adjScratch).ground_offset_m : null)
    road.add(strip.mesh)
    sinkUnderStrip(terrainGeo, strip.heightAt)
    group.add(road)
    // everything that stands on the ground near the road stands on the strip
    const groundNear = (x: number, y: number) => strip.heightAt(x, -y) ?? heightAt(x, y)
    groundAtWorld = (x, z) => strip.heightAt(x, z) ?? heightAt(x, -z)
    edgeDistanceWorld = (x, z) => edgeDistance(x, z).d
    status('planting…')
    const treeAdj = { ...NEUTRAL_ADJ }
    const t = treesFromCanopy(chm.data, chm.layer.size, chm.layer.bbox, chm.layer.res, heightAt, lite ? 25_000 : 120_000, 3, (x, y) => {
      if (roadDistance(x, -y) < 3) return true
      if (!adjustments.active) return false
      const a = adjustments.at(x, y, treeAdj)
      // thin (or thicken, up to the canopy cells available) by a stable hash of position
      return a.tree_density < 1 && hash2(x, y) > a.tree_density
    }, adjustments.active ? (x, y) => adjustments.at(x, y, treeAdj).species : undefined)
    // a coarse grid of the trees for collision queries: cell 16 m, trunk radius from height
    const tgCell = 16
    const treeGrid = new Map<string, [number, number, number][]>()
    for (const r of t.records) {
      const k = `${Math.floor(r.x / tgCell)},${Math.floor(r.z / tgCell)}`
      const arr = treeGrid.get(k)
      const rec: [number, number, number] = [r.x, r.z, Math.max(0.25, r.h * 0.025)]
      if (arr) arr.push(rec)
      else treeGrid.set(k, [rec])
    }
    treesNearWorld = (x, z, rad) => {
      const out: [number, number, number][] = []
      const cx = Math.floor(x / tgCell), cz = Math.floor(z / tgCell)
      const n = Math.ceil(rad / tgCell)
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const arr = treeGrid.get(`${cx + a},${cz + b}`)
        if (arr) for (const r of arr) if (Math.hypot(r[0] - x, r[1] - z) <= rad + r[2]) out.push(r)
      }
      return out
    }
    trees = new THREE.Group()
    trees.name = 'trees'
    treeCount = t.count
    group.add(trees)
    // near field: real (procedural) tree models around the eye
    status('growing…')
    const near = new NearTrees(t.records, lite ? 140 : 240, lite ? 40 : 140)
    trees.add(near.group)
    // grass on the verge: open ground (no canopy), off the pavement, mown near the shoulder
    const canopyAt = sampler(chm)
    const grassAdj = { ...NEUTRAL_ADJ }
    const grass = new Grass(groundNear, canopyAt, roadDistance, 0, LOOK[currentSeason], lite ? 90_000 : 400_000, lite ? 26 : 40, fog, adjustments.active ? (x, y) => { const a = adjustments.at(x, y, grassAdj); return [a.grass_height, a.grass_density] } : undefined)
    trees.add(grass.mesh)
    let imp: Impostors | null = null
    let refreshFar = (_skip: Set<number>) => {}
    if (renderer) {
      // far field: the SAME models as impostors, one quad a tree, re-assigned as the eye moves
      status('baking impostors…')
      near.setSeason(LOOK[currentSeason])
      imp = new Impostors(renderer, near.sources(), t.records.length, fog)
      trees.add(imp.mesh)
      const m = new THREE.Matrix4()
      // every tree gets its impostor slot ONCE (slot = tree index); the near set only toggles
      const sizes = new Float32Array(t.records.length)
      t.records.forEach((r, i) => {
        const v = near.variantFor(r, i)
        sizes[i] = r.h * imp!.extents[v]
        imp!.set(i, r.x, r.y, r.z, r.h, v, ((i * 137) % 360) * (Math.PI / 180), m)
      })
      imp.commit(t.records.length)
      let shown = new Set<number>()
      refreshFar = (skip: Set<number>) => {
        imp!.clearRanges()
        for (const i of shown) if (!skip.has(i)) imp!.setVisible(i, true, sizes[i])
        for (const i of skip) if (!shown.has(i)) imp!.setVisible(i, false, sizes[i])
        shown = new Set(skip)
      }
      updateNear = (eye: THREE.Vector3, time: number) => {
        if (near.update(eye)) refreshFar(near.near)
        grass.update(eye)
        grass.tick(time)
      }
    } else {
      // no renderer (tests): lollipops for everything
      trees.add(t.crowns, t.trunks)
      updateNear = (eye: THREE.Vector3, time: number) => {
        if (near.update(eye)) t.refresh(near.near)
        grass.update(eye)
        grass.tick(time)
      }
    }
    setSeason = (season: Season) => {
      currentSeason = season
      const look = LOOK[season]
      near.setSeason(look)
      grass.setLook(look)
      strip.setTint(look.grass.base.clone().multiplyScalar(2.0).lerp(new THREE.Color(0xffffff), 0.4), imagery ? look.ground : bare)
      terrainMat.color.copy(imagery && terrainMat.map ? look.ground : bare)
      if (horizon && (horizon.material as THREE.MeshStandardMaterial).map) (horizon.material as THREE.MeshStandardMaterial).color.copy(look.ground)
      if (imp) imp.rebake(near.sources())
    }
  }
  // the photo: a ring on the road and an arrow along the recorded heading
  const photo = spineAt(manifest.spine.photo_s)
  const ring = new THREE.Mesh(new THREE.TorusGeometry(6, 0.5, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  ring.rotation.x = Math.PI / 2
  ring.position.copy(photo.pos).add(new THREE.Vector3(0, 0.8, 0))
  const heading = manifest.photos.find((p) => p.heading_deg != null)?.heading_deg
  if (heading != null) {
    const h = (heading * Math.PI) / 180
    const dir = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h))
    spine.add(new THREE.ArrowHelper(dir, ring.position.clone().add(new THREE.Vector3(0, 2, 0)), 25, 0xffffff, 6, 3))
  }
  group.add(spine)

  // --- structures and crossings ----------------------------------------------------------------
  const structures = new THREE.Group()
  structures.name = 'structures'
  const yaw = (d: THREE.Vector3) => Math.atan2(d.x, d.z)
  const markers = new THREE.Group()
  markers.name = 'markers'
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9 })
  for (const st of manifest.structures) {
    const mid = spineAt((st.s_start + st.s_end) / 2)
    let mesh: THREE.Mesh
    if (st.kind === 'bridge') {
      // a bridge we are on: concrete parapets along both pavement edges and an edge beam below the
      // deck, following the curve station by station — the deck itself is the road surface
      const w = pavedWidth(lanesAt((st.s_start + st.s_end) / 2)) / 2 + 0.6
      for (let s = st.s_start; s < st.s_end; s += 4) {
        const a = spineAt(s), b = spineAt(Math.min(st.s_end, s + 4))
        const dir = b.pos.clone().sub(a.pos)
        const len = dir.length() + 0.05
        dir.normalize()
        const side = dir.clone().cross(new THREE.Vector3(0, 1, 0))
        const c = a.pos.clone().lerp(b.pos, 0.5)
        for (const sgn of [-1, 1]) {
          const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.0, len), concrete)
          parapet.position.copy(c).add(side.clone().multiplyScalar(sgn * w)).add(new THREE.Vector3(0, 0.5, 0))
          parapet.rotation.y = yaw(dir)
          parapet.userData = { structure: st }
          structures.add(parapet)
          const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, len), concrete)
          beam.position.copy(c).add(side.clone().multiplyScalar(sgn * (w - 0.3))).add(new THREE.Vector3(0, -0.9, 0))
          beam.rotation.y = yaw(dir)
          structures.add(beam)
        }
      }
      // the other carriageway crosses the same valley: parapets on it over the same stations
      for (const sib of sibAts) {
        const w2 = pavedWidth(2) / 2 + 0.6
        for (let s2 = 0; s2 < sib.len; s2 += 4) {
          const ss = sib.spineS(s2)
          if (ss < st.s_start || ss > st.s_end) continue
          const a = sib.at(s2), b = sib.at(Math.min(sib.len, s2 + 4))
          const dir = b.pos.clone().sub(a.pos)
          const len = dir.length() + 0.05
          dir.normalize()
          const side = dir.clone().cross(new THREE.Vector3(0, 1, 0))
          const c = a.pos.clone().lerp(b.pos, 0.5)
          for (const sgn of [-1, 1]) {
            const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.0, len), concrete)
            parapet.position.copy(c).add(side.clone().multiplyScalar(sgn * w2)).add(new THREE.Vector3(0, 0.5, 0))
            parapet.rotation.y = yaw(dir)
            structures.add(parapet)
            const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, len), concrete)
            beam.position.copy(c).add(side.clone().multiplyScalar(sgn * (w2 - 0.3))).add(new THREE.Vector3(0, -0.9, 0))
            beam.rotation.y = yaw(dir)
            structures.add(beam)
          }
        }
      }
      continue
    } else if (st.kind === 'gantry') {
      const deck = st.deck_z_min ?? mid.pos.y + (st.clearance_m ?? 6)
      mesh = new THREE.Mesh(new THREE.BoxGeometry(24, 0.6, Math.max(1, st.length_m)), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.8 }))
      mesh.position.set(mid.pos.x, deck + 0.3, mid.pos.z)
    } else {
      const deck = st.deck_z_min ?? mid.pos.y + (st.clearance_m ?? 6)
      const width = pavedWidth(lanesAt((st.s_start + st.s_end) / 2))
      const op = overpassMesh({ pos: mid.pos, dir: mid.dir.clone().setY(0).normalize(), s: 0 }, deck, st.length_m, width, heightAt)
      op.traverse((o) => { o.userData = { structure: st } })
      structures.add(op)
      continue
    }
    mesh.rotation.y = yaw(mid.dir)
    mesh.userData = { structure: st }
    structures.add(mesh)
  }
  for (const c of manifest.crossings) {
    if (c.relation === 'merge' || c.relation === 'grade') continue
    const at = spineAt(c.s)
    const over = c.relation === 'over'
    const m = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), new THREE.MeshBasicMaterial({ color: over ? 0xff4040 : 0x4080ff }))
    m.position.copy(at.pos).add(new THREE.Vector3(0, over ? 9 : -0.5, 0))
    m.userData = { crossing: c }
    markers.add(m)
  }
  // the photo ring and heading arrow are analysis, not scenery: they live with the markers
  markers.add(ring)
  for (const o of [...spine.children]) if (o instanceof THREE.ArrowHelper) { spine.remove(o); markers.add(o) }
  markers.visible = false
  group.add(structures)
  group.add(markers)

  // placed assets from the editor
  status('placing…')
  const placementsGroup = await buildPlacements(await loadPlacements(manifest.slug), await loadCatalog(), groundAtWorld)
  group.add(placementsGroup)

  return {
    manifest,
    group,
    layers: { imagery: terrain, canopy, trees, road, horizon, structures, spine, markers, placements: placementsGroup },
    adjustments,
    treeCount,
    updateNear,
    setSeason,
    groundAt: groundAtWorld,
    edgeDistance: edgeDistanceWorld,
    treesNear: treesNearWorld,
    terrain,
    heightAt,
    spineAt,
    setImagery: (on) => {
      terrainMat.map = on ? imagery : null
      terrainMat.color.copy(on && imagery ? LOOK[currentSeason].ground : bare)
      terrainMat.needsUpdate = true
    },
    setWire: (on) => {
      terrainMat.wireframe = on
    },
  }
}

export function describe(st: Structure): string {
  const span = `${st.s_start.toFixed(0)}–${st.s_end.toFixed(0)} m (${st.length_m} m)`
  if (st.kind === 'bridge') return `bridge we are on, ${span}, deck ${st.height_above_ground_m ?? '?'} m above the ground below`
  if (st.kind === 'gantry') return `gantry, ${span}, ${st.clearance_m ?? '?'} m clearance`
  return `overpass, ${span}, ${st.clearance_m ?? '?'} m clearance (deck at ${st.deck_z_min ?? '?'} m)`
}

/** Stable 0..1 hash of a site-frame position, for density thinning. */
function hash2(x: number, y: number): number {
  let h = (Math.floor(x * 4) * 73856093) ^ (Math.floor(y * 4) * 19349663)
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
