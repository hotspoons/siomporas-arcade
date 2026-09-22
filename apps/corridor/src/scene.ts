// Build a three.js scene from a site manifest. World frame: X = east, Y = up (metres NAVD88),
// Z = south — i.e. (x, y, z)_site -> (x, z, -y)_three, right-handed with Y up so nothing in
// three's camera/controls code has to be told about Z-up.
import * as THREE from 'three'
import * as T from './tuning'
import { Anchor } from '@apex/engine/geo/wgs84'
import { RasterFrame } from '@apex/engine/geo/raster'
import { loadBakedTexture } from './textures'
import { DATA_BASE, decodeHeights, decodeScalar, loadImage, type Layer, type Manifest, type Structure } from './site'
import { NearTrees, type TreeRecord } from './trees'
import { Impostors } from './impostors'
import { Grass } from './grass'
import { siteLook, type Season } from './season'
import { GRASS_TYPES, GROUND_COVER, floorTexture, siteCover } from './groundcover'
import { loadFlora, type Flora } from './flora'
import { CROP_TYPES, buildCrops, tickCrops, type CropType, type Field as CropField } from './crops'
import { ACCUM_PARS, Precipitation, accumUniforms, type Weather } from './weather'
import { BoundsIndex, buildStrip, sinkUnderStrips } from './strip'
import { mapBudgeted } from './budget'
import { Adjustments, NEUTRAL as NEUTRAL_ADJ } from './adjust'
import { buildPlacements, loadCatalog, loadPlacements } from './placements'
import { buildBuildings } from './buildings'
import { buildPower } from './power'
import { buildBarriers, buildFurniture, buildSidewalks } from './furniture'
import { buildParking } from './parking'
import { buildBridges, flattenSpine, loadStructureOverrides, suppressed } from './structures'
import { loadSurfaceSets, overpassMesh, pavedOffset, pavedWidth, roadMesh, stations, taperedLanes, treesFromCanopy, type SurfaceSet } from './props'
import { buildRocks } from './rocks'
import { buildWater } from './water'

let surfaceSets: Record<string, SurfaceSet> | null = null

export const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

export interface Site {
  manifest: Manifest
  group: THREE.Group
  layers: { imagery?: THREE.Mesh; trees?: THREE.Group; grass?: THREE.Group; crops?: THREE.Group; road: THREE.Group; horizon?: THREE.Mesh; structures: THREE.Group; spine: THREE.Group; markers: THREE.Group; placements: THREE.Group; buildings: THREE.Group; power: THREE.Group; furniture: THREE.Group; parking: THREE.Group; barriers: THREE.Group; sidewalks: THREE.Group; rocks: THREE.Group; water: THREE.Group }
  /** how many footprints were massed, and how many had a real measured height */
  buildingStats: { count: number; gabled: number; fromLidar: number }
  adjustments: Adjustments
  treeCount: number
  /** the grass field, when this site has one (probes and the HUD read `grass.counts`) */
  grass: Grass | null
  /** how long each build phase took (ms), in order — `status()` marks the boundaries */
  buildProfile: { phase: string; ms: number }[]
  /** what street furniture was placed, and how much of it had to be walked off the carriageway */
  furnitureCounts: { masts: number; signs: number; movedOffPavement: number; stillOnPavement: number; onTheLeft: number; noRoadNearby: number; armNoRoad: number }
  /** what parking was paved, and why the rest was not */
  parkingCounts: { lots: number; stalls: number; skippedOnRoad: number; skippedKind: number; fromAisles: number; fromFallback: number }
  /** guard rail, fence, wall and hedge: runs, metres and posts by kind */
  barrierCounts: Record<string, { runs: number; metres: number; posts: number }>
  /** sidewalks, kerbs and painted crossings */
  sidewalkCounts: { walks: number; crossings: number; marked: number; bars: number; metres: number; kerbFlat: number }
  /** terrain-and-data: rock instances placed per rock type, and what water was drawn (for probes) */
  rockCounts: Record<string, number>
  waterStats: { lines: number; areas: number; falls: number; length_m: number }
  /** canopy height (m) above the ground at site x,y — the CHM the trees and the grass rule read */
  canopyAt: (x: number, y: number) => number
  /** what grows here: LANDFIRE classes, the FIA species mix and Daymet climate. Null on an old bake. */
  flora: Flora | null
  /** the verge and forest-floor classes this site resolved to, and whether the bake or OSM chose them */
  cover: import('./groundcover').SiteCover
  /** the tree silhouettes this site built, with the real tree each is shaped after */
  treePalette: () => { id: string; after: string; leaf: string; evergreen: boolean }[]
  /** every measured tree's silhouette, counted — the whole species assignment as a histogram */
  treeSpecies: (legacy?: boolean) => Record<string, number>
  /** crop rows built per field, by crop type (probes read this) */
  cropRows: Record<string, number>
  /** what is falling and what has settled */
  setWeather: (w: Weather) => void
  weather: { current: Weather; settled: number; particles: number }
  /** per-frame: move the near-field tree models and the grass ring to follow the eye; fwd/pitch shape the LOD footprint */
  updateNear: (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch?: number) => void
  /** a knob changed: re-pick trees and re-seed grass on the next frame */
  retune: () => void
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
  /** the canopy blanket: 72 MB and 1.05 M vertices, so it is not built until this is first called true */
  setCanopy: (on: boolean) => THREE.Mesh | undefined
}

interface Field {
  layer: Layer
  data: Float32Array
  /**
   * How this raster sits on the ellipsoid. Absent for a site baked before the geodetic frame, in
   * which case the old flat-plane arithmetic below still applies and the site draws as it always
   * did — wrong by the convergence and the curvature, but drawn.
   */
  rf?: RasterFrame
}

/** Attach the ellipsoid placement to a field, if the bake gave us a lattice for it. */
function framed(layer: Layer, data: Float32Array, anchor: Anchor | null): Field {
  return { layer, data, rf: anchor && layer.geo ? new RasterFrame({ size: layer.size, geo: layer.geo }, anchor) : undefined }
}

/**
 * Sample a raster at a world position.
 *
 * `x, y` are SITE metres (east, north) — note the callers pass `-z` for y. With a lattice the
 * lookup goes through `RasterFrame`, because the raster's grid is rotated relative to ENU and
 * bbox arithmetic would read a cell tens of metres away at the far edge of a site. Without one it
 * falls back to the flat arithmetic, which is what the grid actually was.
 */
function sampler(f: Field) {
  if (f.rf) {
    const rf = f.rf
    return (x: number, y: number) => f.data[rf.indexAt(x, y)]
  }
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
  const rf = f.rf
  const enu = [0, 0, 0]
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
      const u = (cc + 0.5) / w
      const v = (rr + 0.5) / h
      const z = f.data[i] + lift(i, rr, cc)
      if (rf) {
        // geodetic from the lattice, then the ellipsoid: the curvature is not a correction added
        // afterwards, it is what the transform returns
        rf.toEnu(u, v, z, enu)
        pos[k * 3] = enu[0]
        pos[k * 3 + 1] = enu[2]
        pos[k * 3 + 2] = -enu[1]
      } else {
        pos[k * 3] = xmin + (cc + 0.5) * f.layer.res
        pos[k * 3 + 1] = z
        pos[k * 3 + 2] = -(ymax - (rr + 0.5) * f.layer.res)
      }
      uv[k * 2] = u
      uv[k * 2 + 1] = 1 - v
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


export async function buildSite(manifestIn: Manifest, rawStatus: (s: string) => void, lite = false, renderer?: THREE.WebGLRenderer, fog: THREE.FogExp2 | null = null, initialSeason: Season = 'summer'): Promise<Site> {
  let manifest = manifestIn
  const base = `/sites/${manifest.slug}/web/`
  const group = new THREE.Group()
  const L = manifest.layers
  if (!L.dem) throw new Error('site has no DEM layer')

  // BUILD PROFILE. A network site of 427 branches takes over two minutes to build and the browser
  // is frozen for all of it, so the first question is always which phase. `status()` already marks
  // every phase boundary; timing it there costs nothing and means the answer is one probe away
  // rather than a bisect. Read it back as `site.buildProfile`.
  const buildProfile: { phase: string; ms: number }[] = []
  let phaseT = performance.now()
  let phaseName = 'start'
  const mark = (next: string) => {
    const now = performance.now()
    buildProfile.push({ phase: phaseName, ms: Math.round(now - phaseT) })
    phaseT = now
    phaseName = next
  }
  const status = (m: string) => {
    mark(m)
    return rawStatus(m)
  }

  // The site's geodetic anchor: the origin of the ENU tangent frame everything is rendered in.
  // Absent on a manifest baked before the geodetic frame, and then every raster falls back to
  // flat-plane arithmetic and the site draws as it always did — see `framed`, docs/corridor/FRAME.md.
  const fa = manifest.frame?.anchor
  const anchor = fa ? new Anchor(fa.lon, fa.lat, fa.h ?? 0) : null
  if (!anchor) console.warn(`${manifest.slug}: no frame.anchor — drawing on a flat plane`)

  status('decoding terrain…')
  const adjustments = await Adjustments.load(manifest.slug)
  // what grows here, from the bake: LANDFIRE vegetation classes, an FIA species mix per class and
  // Daymet's monthly rain. Null on a site baked before the flora layer, and everything downstream
  // falls back to what it did then.
  const flora: Flora | null = await loadFlora(manifest).catch(() => null)
  const cover = siteCover(manifest, flora)
  const look = (s: Season) => siteLook(s, flora)
  const overrides = await loadStructureOverrides(manifest.slug)
  // authored `flatten` intervals rewrite the spine's grade before anything is built from it
  if (overrides.length) manifest = { ...manifest, spine: { ...manifest.spine, coords: flattenSpine(manifest.spine.coords, overrides) }, structures: suppressed(manifest.structures, overrides) }
  const demImg = await loadImage(base + L.dem.file)
  const dem: Field = framed(L.dem, decodeHeights(demImg, L.dem), anchor)
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
      // the compressed twin when the bake made one: ~8x less GPU memory for the same image
      tex = loadBakedTexture(`${DATA_BASE}${base}`, L.naip, renderer)
    }
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = lite ? 2 : 8
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    imagery = tex
  }
  const bare = new THREE.Color(0x6f6a5a)
  const terrainMat = new THREE.MeshStandardMaterial({ map: imagery, color: imagery ? 0xffffff : bare, roughness: 1, metalness: 0 })
  // the coarse terrain takes the settled layer as well, or snow stops at the strip's rim
  const terrainWeather = accumUniforms()
  terrainMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrainWeather)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWWorld;\nvarying vec3 vWNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>\nvarying vec3 vWWorld;\nvarying vec3 vWNormal;\n${ACCUM_PARS}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = applyWeather(diffuseColor.rgb, normalize(vWNormal), vWWorld);')
  }
  terrainMat.customProgramCacheKey = () => 'corridor-terrain'
  const terrain = new THREE.Mesh(terrainGeo, terrainMat)
  terrain.name = 'terrain'
  group.add(terrain)

  // --- canopy: the forest blanket (off by default; the trees below are the stand-ins) --------
  let canopy: THREE.Mesh | undefined
  let makeCanopy: (() => THREE.Mesh) | null = null
  let chm: Field | undefined
  if (L.chm) {
    status('decoding canopy…')
    const chmImg = await loadImage(base + L.chm.file)
    chm = framed(L.chm, decodeScalar(chmImg, L.chm.scale ?? 0.25), anchor)
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
    // The blanket is a DIAGNOSTIC layer, off unless someone ticks the box — and building it was
    // 72 MB of geometry and 1 057 160 vertices that almost every session throws away unseen. So it
    // is a closure now, run on the first tick. The CHM itself stays: `canopyAt`, the tree planter
    // and the grass all read it whether the blanket is drawn or not.
    const cd = chm.data
    makeCanopy = () => {
      const alpha = new THREE.Texture(chmImg)
      alpha.needsUpdate = true
      alpha.flipY = true
      const geo = gridGeometry(dem, stride, (i) => (cd[i] > 1.5 ? cd[i] : 0), (i) => {
        const t = Math.min(1, cd[i] / 30)
        return [0.24 - 0.1 * t, 0.5 - 0.22 * t, 0.2 - 0.09 * t]
      })
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, alphaMap: alpha, alphaTest: 0.03, roughness: 1, side: THREE.DoubleSide })
      const m = new THREE.Mesh(geo, mat)
      m.name = 'canopy'
      group.add(m)
      return m
    }
  }

  // --- far terrain -----------------------------------------------------------------------------
  let horizon: THREE.Mesh | undefined
  if (L.horizon) {
    status('decoding horizon…')
    const hImg = await loadImage(base + L.horizon.file)
    const hz: Field = framed(L.horizon, decodeHeights(hImg, L.horizon), anchor)
    const hs = strideFor(L.horizon, lite ? 120_000 : 300_000)
    const geo = gridGeometry(hz, hs, () => -2.0, L.horizon_naip ? undefined : (i) => hypso(hz.data[i]))
    // The horizon is the FAR field only. Two meshes of the same ground at 60 m and 1-8 m sampling
    // cannot coexist: the coarse one is above the fine one wherever the fine one dips within a
    // cell, and shows through as flat green (Rich's "green stuff", four rounds of it). So every
    // horizon triangle inside the near DEM's footprint is removed, and the one-cell rim that is
    // still inside is pinned 3 m under the near terrain so the two meet without a hole.
    cutHorizon(geo, L.dem.bbox, hz.layer.res * hs, heightAt)
    let mat: THREE.Material
    if (L.horizon_naip) {
      const tex = loadBakedTexture(`${DATA_BASE}${base}`, L.horizon_naip, renderer)
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
  // A network site carries the same roads twice: `siblings` (the old dense-coords key, kept so an
  // older viewer still draws something) and `branches` (with tags, grade and junctions). Drawing
  // both put two carriageways, two paint sets and two strips on every side street — z-fighting
  // paint, doubled stations, and every dead end reading as a junction with its own twin
  // (Rich's neighbourhood, 2026-09-21). Branches supersede siblings.
  const siblings = (manifest.branches?.length ?? 0) > 0 ? [] : manifest.siblings
  const spine = new THREE.Group()
  spine.name = 'spine'
  // analysis overlay: a thin centreline, floating a hand above the pavement so it never floods it
  spine.add(ribbon(sp.map((v) => v.clone().add(new THREE.Vector3(0, 0.5, 0))), 0.35, 0xffdc00))
  for (const sib of siblings) {
    const pts = sib.map(([x, y]) => toWorld(x, y, heightAt(x, y) + 0.9))
    spine.add(ribbon(pts, 0.3, 0xff8c00, 0.9))
  }

  // --- the road surface, as wide as OSM says ---------------------------------------------------
  status('paving…')
  const segs = manifest.spine.segments
  const segAt = (s: number) => segs.find((g) => g.s_start - 0.5 <= s && s <= g.s_end + 0.5)
  const stepLanes = (s: number) => {
    const n = Number(segAt(s)?.tags.lanes)
    return Number.isFinite(n) && n > 0 ? n : 2
  }
  // OSM's lane count is a step function; a lane that appears in one 6 m quad is a road growing
  // sideways. taperedLanes ramps it over ROAD_TAPER_M so the width, the edge line and the shoulder
  // converge together. It goes HERE rather than inside roadMesh so that the asphalt and
  // edgeDistance keep using the same width — that agreement is what the two-way fix restored.
  let taperFor = -1
  let laneFn: (s: number) => number = stepLanes
  const lanesAt = (s: number) => {
    if (taperFor !== T.ROAD_TAPER_M) {
      taperFor = T.ROAD_TAPER_M
      laneFn = taperedLanes(stepLanes, manifest.spine.length_m, T.ROAD_TAPER_M)
    }
    return laneFn(s)
  }
  // OSM: oneway=yes, or a motorway (implicitly one way), is a carriageway; everything else with
  // oneway=no or untagged is a two-way road with traffic both directions on one pavement
  const twoWayAt = (s: number) => {
    const tg = segAt(s)?.tags ?? {}
    if (tg.oneway === 'yes' || tg.oneway === '-1') return false
    if (tg.oneway === 'no') return true
    return !['motorway', 'motorway_link', 'trunk_link', 'primary_link'].includes(tg.highway ?? '')
  }
  const pavedHalfAt = (s: number) => pavedWidth(lanesAt(s), twoWayAt(s)) / 2
  // How far right of the spine the asphalt's centre sits: 0 on a two-way road, half the shoulder
  // difference on a carriageway, because OSM draws a motorway down its travel lanes and not down
  // the middle of its asphalt. edgeDistance has to use this or the pavement the car and the grass
  // believe in drifts 0.9 m from the one the asphalt mesh draws — the same class of disagreement
  // the two-way width fix removed.
  const pavedOffsetAt = (s: number) => pavedOffset(twoWayAt(s))
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
  // --- where the roads meet -----------------------------------------------------------------
  // Three sources, all already in the bake: a network's `branches[].junctions`, the mouth of
  // every `stub` (the end nearest one of our carriageways), and on a single-road site the
  // `crossings` whose relation is a merge or a grade crossing. Paint is suppressed inside these
  // circles, which is how an intersection stops being two sets of lines crossing each other.
  const junctions: { x: number; z: number; r: number }[] = []
  {
    const pushJ = (x: number, z: number, r: number) => junctions.push({ x, z, r })
    for (const br of manifest.branches ?? []) {
      for (const j of br.junctions ?? []) {
        const w = toWorld(j.x, j.y, 0)
        pushJ(w.x, w.z, Math.max(T.JUNCTION_CLEAR, ((br.lanes ?? 2) * T.LANE_WIDTH) / 2 + T.JUNCTION_CLEAR * 0.4))
      }
    }
    for (const sb of manifest.stubs ?? []) {
      const c = sb.coords ?? []
      if (c.length < 2) continue
      // the mouth is whichever end sits on one of our roads; the far end is a dead stop
      for (const e of [c[0], c[c.length - 1]]) {
        const w = toWorld(e[0], e[1], 0)
        pushJ(w.x, w.z, Math.max(T.JUNCTION_CLEAR, ((sb.lanes ?? 2) * T.LANE_WIDTH) / 2 + T.JUNCTION_CLEAR * 0.4))
      }
    }
    if (!(manifest.branches?.length ?? 0)) {
      for (const c of manifest.crossings ?? []) {
        if (c.relation !== 'merge' && c.relation !== 'grade') continue
        const p = spineAt(Math.min(manifest.spine.length_m, Math.max(0, c.s)))
        pushJ(p.pos.x, p.pos.z, T.JUNCTION_CLEAR)
      }
    }
  }
  /** inside any junction circle? asked per marking quad, at that line's own lateral offset */
  const paintOff = (x: number, z: number) => {
    for (const j of junctions) if ((j.x - x) ** 2 + (j.z - z) ** 2 < j.r * j.r) return true
    return false
  }

  // the asphalt and paint are rebuilt when a road knob moves (F6 → road), so keep the builders
  const roadBuilders: (() => THREE.Object3D)[] = [() => roadMesh(mainSt, lanesAt, classAt, surfaceSets!, 0.02, twoWayAt, paintOff)]
  let roadParts: THREE.Object3D[] = []
  const buildRoads = () => {
    for (const o of roadParts) {
      road.remove(o)
      disposeDeep(o)
    }
    roadParts = roadBuilders.map((b) => b())
    for (const o of roadParts) road.add(o)
  }
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
  for (const sib of siblings) {
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
    roadBuilders.push(() => roadMesh(stations(sibAt, len2, 6), () => 2, () => 'asphalt_aged', surfaceSets!, 0.02, () => false, paintOff))
  }
  // --- network branches: every other road of a network site is a first-class carriageway --------
  // Its grade is its own lidar profile (the bake densified it like the spine), its lanes and
  // direction its own OSM tags; it gets stations in the edge grid (so grass, trees and the car
  // know it is pavement), an asphalt+paint mesh, and below, its own strip. Kept apart from the
  // divided-highway siblings: those share the spine's grade and widen the spine's strip.
  const branchAts: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number; half: number; name: string }[] = []
  for (const br of manifest.branches ?? []) {
    if (!br.coords || br.coords.length < 2) continue
    const rawB = br.coords.map(([x, y, z]) => toWorld(x, y, (Number.isFinite(z) ? z : heightAt(x, y)) + 0.4))
    const cB = new THREE.CatmullRomCurve3(rawB, false, 'centripetal')
    cB.arcLengthDivisions = Math.max(100, rawB.length * 8)
    const lenB = cB.getLength()
    const atB = (s: number) => {
      const u = Math.min(1, Math.max(0, s / lenB))
      return { pos: cB.getPointAt(u), dir: cB.getTangentAt(u) }
    }
    const lanesB = Number(br.lanes) > 0 ? Number(br.lanes) : 2
    const twoWayB = br.oneway === 'yes' || br.oneway === '-1' ? false : br.oneway === 'no' ? true : !['motorway', 'motorway_link', 'trunk_link', 'primary_link'].includes(br.highway ?? '')
    const halfB = pavedWidth(lanesB, twoWayB) / 2
    roadBuilders.push(() => roadMesh(stations(atB, lenB, 6), () => lanesB, () => 'asphalt_aged', surfaceSets!, 0.02, () => twoWayB, paintOff))
    branchAts.push({ at: atB, len: lenB, half: halfB, name: br.name ?? br.ref ?? 'branch' })
  }
  buildRoads()

  // --- trees, one per canopy cell, as tall as the lidar says ---------------------------------
  let trees: THREE.Group | undefined
  let treeCount = 0
  let updateNear: (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch?: number) => void = () => {}
  let retune: () => void = () => {}
  let setSeason: (season: Season) => void = () => {}
  let groundAtWorld: (x: number, z: number) => number | null = (x, z) => heightAt(x, -z)
  let edgeDistanceWorld: (x: number, z: number) => number = () => Infinity
  let treesNearWorld: (x: number, z: number, r: number) => [number, number, number][] = () => []
  let currentSeason: Season = initialSeason
  let grassRef: Grass | null = null
  // the near-tree set and the measured tree list, for probes/corridor-flora.mjs: which silhouettes
  // this site built and which one every one of its tens of thousands of trees drew
  let nearRef: NearTrees | null = null
  let treeRecords: TreeRecord[] = []
  let crops: ReturnType<typeof buildCrops> | null = null
  let precip: Precipitation | null = null
  let canopyAtRef: (x: number, y: number) => number = () => 0
  if (chm) {
    // distance to the nearest PAVEMENT EDGE of any carriageway (negative = on the pavement):
    // stations every 5 m from the spine and every sibling, hashed on a 20 m grid with each
    // station carrying its own half width. Grass, verges and tree exclusion all ask this.
    const stCell = 20
    const stGrid = new Map<string, { x: number; z: number; dx: number; dz: number; s: number; half: number; who: number; off: number; y?: number }[]>()
    // one height function per carriageway: the SAME spline the road mesh is drawn from
    const curves: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number }[] = [{ at: spineAt, len: curveLen }, ...sibAts.map((s) => ({ at: s.at, len: s.len })), ...branchAts.map((b) => ({ at: b.at, len: b.len }))]
    const branchWho0 = 1 + sibAts.length // `who` of the first branch in the station grid
    const halfOf = (who: number, s: number) => (who === 0 ? pavedHalfAt(s) : who < branchWho0 ? pavedWidth(2) / 2 : branchAts[who - branchWho0].half)
    const addStations = (who: number, halfAt: (s: number) => number, offAt: (s: number) => number = () => 0) => {
      const c = curves[who]
      for (let s = 0; s <= c.len; s += 5) {
        const st = c.at(s)
        const d = st.dir.clone().setY(0).normalize()
        const k = `${Math.floor(st.pos.x / stCell)},${Math.floor(st.pos.z / stCell)}`
        const arr = stGrid.get(k)
        const rec = { x: st.pos.x, z: st.pos.z, dx: d.x, dz: d.z, s, half: halfAt(s), off: offAt(s), who }
        if (arr) arr.push(rec)
        else stGrid.set(k, [rec])
      }
    }
    addStations(0, pavedHalfAt, pavedOffsetAt)
    for (let i = 0; i < sibAts.length; i++) addStations(i + 1, () => pavedWidth(2) / 2)
    for (let i = 0; i < branchAts.length; i++) addStations(branchWho0 + i, () => branchAts[i].half)

    // --- cul-de-sacs ------------------------------------------------------------------------
    // "if a street dead ends, assume a cul de sac" (Rich, 2026-09-21). An end is a dead end when
    // it is not a junction with another carriageway AND not simply where we clipped the corridor.
    // One station at the bulb centre IS the bulb: outside the ±2.6 m along-track band
    // `edgeDistance` measures radially and subtracts `half`, so a lone station is a disc — grass,
    // trees and the car all see pavement there for free. The bake will carry `dead_ends` per road
    // (kind + radius, overridable in the editor); until it does, the geometry decides.
    const [dbx0, dby0, dbx1, dby1] = manifest.bbox
    const nearBboxEdge = (x: number, wz: number) => {
      const y = -wz
      return Math.min(x - dbx0, dbx1 - x, y - dby0, dby1 - y) < 60
    }
    const junctionNear = (x: number, z: number, self: number) => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
        for (const p of stGrid.get(`${cx + a},${cz + b}`) ?? []) {
          if (p.who === self) continue
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < 225) return true // 15 m: a bulb is ~9 m, and a 75 m court runs close to the next street
        }
      }
      return false
    }
    const deadEnds: { x: number; z: number; dx: number; dz: number; who: number; s: number; radius?: number }[] = []
    // the bake's answer wins where it has one: `dead_ends` per road resolves the ends against OSM
    // (a shared node, a turning circle, a way outside our list) and the editor can turn any of
    // them into a true dead end. Geometry only decides for roads the bake has not spoken about.
    const authored = new Map<number, import('./site').DeadEnd[]>()
    if (manifest.spine.dead_ends?.length) authored.set(0, manifest.spine.dead_ends)
    for (let i = 0; i < branchAts.length; i++) {
      const de = (manifest.branches ?? [])[i]?.dead_ends
      if (de?.length) authored.set(branchWho0 + i, de)
    }
    for (let who = 0; who < curves.length; who++) {
      const c = curves[who]
      const said = authored.get(who)
      if (said) {
        for (const de of said) {
          if (de.kind !== 'cul_de_sac') continue
          const s = Math.min(c.len, Math.max(0, de.s))
          const st = c.at(s)
          const sign = s > c.len / 2 ? 1 : -1
          const d = st.dir.clone().setY(0).normalize().multiplyScalar(sign)
          deadEnds.push({ x: st.pos.x, z: st.pos.z, dx: d.x, dz: d.z, who, s, radius: de.radius_m })
        }
        continue
      }
      for (const [s, sign] of [[0, -1], [c.len, 1]] as [number, number][]) {
        const st = c.at(Math.min(c.len, Math.max(0, s)))
        const d = st.dir.clone().setY(0).normalize().multiplyScalar(sign)
        const atEdge = nearBboxEdge(st.pos.x, st.pos.z), atJunction = junctionNear(st.pos.x, st.pos.z, who)
        console.info(`end who=${who} s=${s.toFixed(0)} edge=${atEdge} junction=${atJunction} at ${st.pos.x.toFixed(0)},${st.pos.z.toFixed(0)}`)
        if (atEdge || atJunction) continue
        deadEnds.push({ x: st.pos.x, z: st.pos.z, dx: d.x, dz: d.z, who, s })
      }
    }
    type St = { x: number; z: number; dx: number; dz: number; s: number; half: number; who: number; off: number; y?: number }
    const bulbStations: St[] = []
    const placeBulbs = () => {
      for (const b of bulbStations) {
        const arr = stGrid.get(`${Math.floor(b.x / stCell)},${Math.floor(b.z / stCell)}`)
        if (arr && arr.indexOf(b) >= 0) arr.splice(arr.indexOf(b), 1)
      }
      bulbStations.length = 0
      if (T.CULDESAC_RADIUS <= 0) return
      for (const e of deadEnds) {
        // the bulb sits just beyond the last metre of pavement, as a turning circle does
        const r = e.radius && e.radius > 0 ? e.radius : T.CULDESAC_RADIUS
        const bx = e.x + e.dx * r * 0.6, bz = e.z + e.dz * r * 0.6
        const rec: St = { x: bx, z: bz, dx: e.dx, dz: e.dz, s: e.s, half: r, who: e.who, off: 0 }
        bulbStations.push(rec)
        const k = `${Math.floor(bx / stCell)},${Math.floor(bz / stCell)}`
        const arr = stGrid.get(k)
        if (arr) arr.push(rec)
        else stGrid.set(k, [rec])
      }
    }
    placeBulbs()
    /** signed distance to the nearest pavement edge, and which carriageway that was */
    const edgeDistance = (x: number, z: number, exclude = -1): { d: number; who: number; y: number } => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      let best = Infinity, who = -1, bp: (typeof stGrid extends Map<string, (infer R)[]> ? R : never) | null = null
      for (let a = -3; a <= 3; a++) {
        for (let b = -3; b <= 3; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            if (p.who === exclude) continue
            // lateral distance to the station's tangent, so a point between two stations measures
            // to the road and not to the nearer station's dot
            const ux = x - p.x, uz = z - p.z
            const along = ux * p.dx + uz * p.dz
            // signed lateral, + to the right of travel (right = dir x UP = (-dz, 0, dx)), measured
            // from the asphalt's centre rather than the spine; with off = 0 this is the old |lat|
            const lat = Math.abs(uz * p.dx - ux * p.dz - p.off)
            const d = (Math.abs(along) <= 2.6 ? lat : Math.hypot(ux, uz)) - p.half
            if (d < best) { best = d; who = p.who; bp = p }
          }
        }
      }
      if (!bp) return { d: best, who, y: 0 }
      // a driveway (who < 0) is not a carriageway and has no spline: it carries its own height
      if (bp.who < 0) return { d: best, who: bp.who, y: bp.y ?? 0 }
      // the road height HERE, from the carriageway spline at the projected along-track metre —
      // the very same function the asphalt mesh is built from, so ground and road agree to the mm
      const along = (x - bp.x) * bp.dx + (z - bp.z) * bp.dz
      const c = curves[bp.who]
      const y = c.at(Math.min(c.len, Math.max(0, bp.s + along))).pos.y // the spline IS the road surface
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
    // the CHM the grass generator already rejects cells by; the strip needs it to know where the
    // ground is forest floor rather than turf
    const stripCanopyAt = chm ? sampler(chm) : null
    // the forest floor is the site's dominant TREE ground class: spruce duff at Acadia, bay and
    // live-oak litter at Big Sur, the oak-hickory that used to be painted everywhere in Maryland
    const litter = renderer && chm ? floorTexture(cover.floor) : null
    /**
     * On a bridge the verge stops at the parapet. Everywhere else the strip blends from road grade
     * back to the DEM over 7 m, but on a deck the DEM is the valley floor 5–12 m below and the
     * blend cannot reach it, so the 40 m verge stayed at deck height: a shelf hanging over the
     * valley, with grass and trees standing on it (Rich's Braddock screenshot). The deck itself is
     * the road mesh and the car reads its height from this strip, so the strip must stay — only
     * its width goes. Tapered over BRIDGE_TAPER either side so the verge runs out onto the
     * abutment instead of ending in a wall.
     */
    const BRIDGE_TAPER = 10
    const decks = manifest.structures.filter((st) => st.kind === 'bridge')
    const stripEdgeLimitAt = (s: number): number => {
      let lim = VERGE
      for (const b of decks) {
        const on = Math.min(
          THREE.MathUtils.smoothstep(s, b.s_start - BRIDGE_TAPER, b.s_start),
          1 - THREE.MathUtils.smoothstep(s, b.s_end, b.s_end + BRIDGE_TAPER),
        )
        if (on <= 0) continue
        const parapet = 1.0 // the parapets in the structures pass stand 0.6 m outside the pavement
        lim = Math.min(lim, parapet + (VERGE - parapet) * (1 - on))
      }
      return lim
    }
    const makeStrip = () => buildStrip(spineAt, curveLen, -latMin + VERGE, latMax + VERGE, (x, z) => edgeDistance(x, z), heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 2, lite ? 2 : 1, adjustments.active ? (x, y) => adjustments.at(x, y, adjScratch).ground_offset_m : null, null, stripEdgeLimitAt, stripCanopyAt, litter)
    mark('grade: setup')
    let strip = makeStrip()
    strip.setLitter(look(currentSeason).litter.tint, look(currentSeason).litter.spread)
    road.add(strip.mesh)
    mark('grade: primary strip')
    mark('grade: sink primary')
    // one strip per branch; where another road's strip already covers the ground (within VERGE of
    // its pavement edge) the branch strip leaves a hole rather than a second coplanar surface
    /**
     * A BRANCH GETS A NARROWER, COARSER STRIP THAN THE PRIMARY.
     *
     * The primary is the road you drive, so it gets 40 m of verge sampled every 2 m along and 1 m
     * across. Giving a residential branch the same is wrong twice over. Wrong visually: streets in
     * a subdivision are a hundred metres apart, so 40 m of verge each side means every strip
     * overlaps its neighbours and the whole grid is paved twice. And wrong in cost: 427 branches at
     * that resolution was **21.7 s of the build**, because every vertex asks `edgeDistance`, which
     * projects onto the station grid.
     *
     * BRANCH_VERGE (14 m) and a 2 m lateral step cut the vertices per branch about six-fold. The
     * ground beyond the verge is the coarse terrain, which is what it should be that far from a
     * residential street anyway.
     */
    const makeBranchStrips = () => mapBudgeted(branchAts, (b, i) => buildStrip(b.at, b.len, T.BRANCH_VERGE, T.BRANCH_VERGE, (x, z) => edgeDistance(x, z), heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 3, lite ? 3 : 2, adjustments.active ? (x, y) => adjustments.at(x, y, adjScratch).ground_offset_m : null, (s) => {
      const q = b.at(s).pos
      return edgeDistance(q.x, q.z, branchWho0 + i).d < T.BRANCH_VERGE
    }), 8, (done, total) => rawStatus(`grading ${done}/${total} streets…`))
    // --- driveways -------------------------------------------------------------------------
    // Every house on Rich's court has one in OSM and we were dropping them, so the houses stood
    // in grass. Unmarked asphalt, 3.2 m, laid on the strip where the strip covers them and on the
    // DEM grade beyond it. They get stations too, so grass and trees keep off them and the car
    // knows it is on pavement when it pulls in.
    const driveGroup = new THREE.Group()
    driveGroup.name = 'driveways'
    road.add(driveGroup)
    const driveStations: St[] = []
    const makeDriveways = () => {
      for (const o of [...driveGroup.children]) {
        driveGroup.remove(o)
        ;(o as THREE.Mesh).geometry.dispose()
      }
      for (const st of driveStations) {
        const arr = stGrid.get(`${Math.floor(st.x / stCell)},${Math.floor(st.z / stCell)}`)
        const i = arr?.indexOf(st) ?? -1
        if (arr && i >= 0) arr.splice(i, 1)
      }
      driveStations.length = 0
      const set = surfaceSets?.asphalt_aged
      const mat = set ? set.material : new THREE.MeshStandardMaterial({ color: 0x3b3b3d, roughness: 1 })
      const mpt = set?.metresPerTile ?? 1
      const pos: number[] = [], uv: number[] = [], idx: number[] = []
      const ribbons: { coords: [number, number, number][]; width: number; flare?: boolean }[] = [
        // a driveway meets the road at a dropped kerb, not a flared mouth
        ...(manifest.driveways ?? []).map((d) => ({ coords: d.coords, width: d.width_m ?? 3.6, flare: false })),
        // a road we do not model, stubbed in from the junction: full width, still unmarked —
        // paint on a 60 m stub that ends in nothing would draw the eye to the seam
        ...(manifest.stubs ?? []).map((s) => ({ coords: s.coords, width: Math.max(5.5, (s.lanes ?? 2) * 3.1 + 0.8), flare: true })),
      ]
      for (const dw of ribbons) {
        const pts = (dw.coords ?? []).map(([x, y, z]) => toWorld(x, y, z))
        if (pts.length < 2) continue
        const half = Math.max(1.2, (dw.width ?? 3.6) / 2)
        // the mouth: a side road flares where it meets ours, and drawing it at a constant width
        // right to the edge is most of why Rich's junction read as an abandoned track. Widen over
        // the last `MOUTH` metres of whichever end is closest to a carriageway of ours.
        const MOUTH = 11
        const endNearRoad = [0, pts.length - 1].map((i) => edgeDistance(pts[i].x, pts[i].z, -1).d)
        const flareAt = dw.flare === false ? -1 : endNearRoad[0] <= endNearRoad[1] ? 0 : pts.length - 1
        const run: number[] = [0]
        for (let i = 1; i < pts.length; i++) run.push(run[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z))
        const total = run[run.length - 1]
        const halfAtI = (i: number) => {
          if (flareAt < 0) return half
          const d = flareAt === 0 ? run[i] : total - run[i]
          if (d >= MOUTH) return half
          const f = 1 - d / MOUTH
          return half + f * f * half * 1.5 // a quadratic flare reads as the corner radius
        }
        const base = pos.length / 3
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]
          const dx = b.x - a.x, dz = b.z - a.z
          const n = Math.hypot(dx, dz) || 1
          const sx = -dz / n, sz = dx / n // right of travel
          const g = groundAtWorld(pts[i].x, pts[i].z)
          const y = (g ?? pts[i].y) + 0.03
          const hw = halfAtI(i)
          for (const s of [-1, 1]) {
            pos.push(pts[i].x + sx * hw * s, y, pts[i].z + sz * hw * s)
            uv.push((pts[i].x + sx * hw * s) / mpt, (pts[i].z + sz * hw * s) / mpt)
          }
          // A STATION AT EVERY POINT. edgeDistance treats a lone station as a disc beyond ±2.6 m
          // along-track, so stations 8 m apart left 1.4 m gaps between the discs and grass grew
          // up through the asphalt in every one of them (Rich, 2026-09-21). At 4 m spacing every
          // point on the ribbon is inside some station's along-track band.
          const rec: St = { x: pts[i].x, z: pts[i].z, dx: dx / n, dz: dz / n, s: 0, half: hw + 0.4, who: -2, off: 0, y }
          driveStations.push(rec)
          const k = `${Math.floor(rec.x / stCell)},${Math.floor(rec.z / stCell)}`
          const arr = stGrid.get(k)
          if (arr) arr.push(rec)
          else stGrid.set(k, [rec])
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const a = base + i * 2
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
      }
      if (idx.length) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
        geo.setIndex(idx)
        geo.computeVertexNormals()
        const mesh = new THREE.Mesh(geo, mat)
        mesh.name = 'road:driveways'
        driveGroup.add(mesh)
      }
    }

    const bulbGroup = new THREE.Group()
    bulbGroup.name = 'culdesacs'
    road.add(bulbGroup)
    const makeBulbs = () => {
      for (const o of [...bulbGroup.children]) {
        bulbGroup.remove(o)
        ;(o as THREE.Mesh).geometry.dispose()
      }
      for (const b of bulbStations) {
        const geo = new THREE.CircleGeometry(b.half, 36)
        geo.rotateX(-Math.PI / 2)
        // UVs in METRES over the tile, like roadMesh: CircleGeometry's own 0..1 UVs stretch one
        // tile across the whole 18 m bulb, which is the blotchy over-scaled asphalt Rich saw.
        const set = surfaceSets?.asphalt_aged
        const mpt = set?.metresPerTile ?? 1
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute
        const pos0 = geo.getAttribute('position') as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) uv.setXY(i, (b.x + pos0.getX(i)) / mpt, (b.z + pos0.getZ(i)) / mpt)
        uv.needsUpdate = true
        const mesh = new THREE.Mesh(geo, set ? set.material : new THREE.MeshStandardMaterial({ color: 0x3b3b3d, roughness: 1 }))
        const c = curves[b.who]
        mesh.position.set(b.x, c.at(Math.min(c.len, Math.max(0, b.s))).pos.y + 0.02, b.z)
        mesh.name = 'road:culdesac'
        bulbGroup.add(mesh)
      }
    }
    makeBulbs()
    let branchStrips = await makeBranchStrips()
    mark('grade: branch strips built')
    for (const bs of branchStrips) road.add(bs.mesh)
    // ONE pass for every strip, primary and branches together
    sinkUnderStrips(terrainGeo, [strip, ...branchStrips])
    mark('grade: sink all strips')
    // The branches go in a bounds grid: this lookup is the single hottest thing in the build, and
    // walking all 427 of them was 45 µs a call against 0.4 µs for a point on the primary strip.
    // See BoundsIndex in strip.ts for the measurement.
    let branchIndex = new BoundsIndex(branchStrips)
    const stripHeight = (x: number, z: number): number | null => {
      const h = strip.heightAt(x, z)
      if (h !== null) return h
      return branchIndex.firstAt(x, z, (bs) => bs.heightAt(x, z))
    }
    // a road knob moved: every station's half width, the asphalt, then the strip that hugs it
    const roadSignature = () => `${T.LANE_WIDTH}|${T.SHOULDER_OUT}|${T.SHOULDER_IN}|${T.ROAD_BLEND_M}|${T.ROAD_TAPER_M}|${T.ROAD_ONEWAY_CENTRE}|${T.CULDESAC_RADIUS}`
    let roadSig = roadSignature()
    let roadTimer: ReturnType<typeof setTimeout> | undefined
    // async because the branch strips are budgeted: a knob change on a 427-branch network used to
    // freeze the tab for as long as the first build did
    const rebuildRoad = async () => {
      for (const arr of stGrid.values()) for (const r of arr) { if (bulbStations.includes(r as St)) continue; r.half = halfOf(r.who, r.s); r.off = r.who === 0 ? pavedOffsetAt(r.s) : 0 }
      placeBulbs()
      makeBulbs()
      makeDriveways()
      buildRoads()
      road.remove(strip.mesh)
      strip.mesh.geometry.dispose()
      strip = makeStrip()
      road.add(strip.mesh)

      for (const bs of branchStrips) {
        road.remove(bs.mesh)
        bs.mesh.geometry.dispose()
      }
      branchStrips = await makeBranchStrips()
      branchIndex = new BoundsIndex(branchStrips)
      for (const bs of branchStrips) road.add(bs.mesh)
      sinkUnderStrips(terrainGeo, [strip, ...branchStrips])
    }
    group.add(road)
    // everything that stands on the ground near the road stands on the strip
    makeDriveways()
    const groundNear = (x: number, y: number) => stripHeight(x, -y) ?? heightAt(x, y)
    groundAtWorld = (x, z) => stripHeight(x, z) ?? heightAt(x, -z)
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
    const near = await new NearTrees(t.records, lite ? 140 : 240, lite ? 60 : 300, flora).grow() // capacity here is the allocation ceiling; the live cap is the knob
    nearRef = near
    treeRecords = t.records
    trees.add(near.group)
    // grass on the verge: open ground (no canopy), off the pavement, mown near the shoulder
    const canopyAt = sampler(chm)
    canopyAtRef = canopyAt
    const grassAdj = { ...NEUTRAL_ADJ }
    const grass = new Grass(groundNear, canopyAt, roadDistance, 0, look(currentSeason), lite ? 90_000 : 400_000, lite ? 26 : 40, fog, adjustments.active ? (x, y) => { const a = adjustments.at(x, y, grassAdj); return a.cover === 'crop' ? [1, 0] : [a.grass_height, a.grass_density] } : undefined, undefined, heightAt)
    // NOT a child of `trees`. It was, and so the trees checkbox turned off all ground cover with
    // them — you could not hide the trees to look at the grass, which is most of what looking at
    // grass involves. Its own group, its own layer toggle.
    group.add(grass.mesh)
    grassRef = grass

    // --- crop fields ---------------------------------------------------------------------------
    // Two sources, as main's 009 sets out: OSM farmland rings from the bake, and the editor's
    // authored `cover: 'crop'` areas, which win where they overlap because a person looked.
    const fields: CropField[] = []
    const asCrop = (v: string | null): CropType | null => (v && (CROP_TYPES as string[]).includes(v) ? (v as CropType) : null)
    // a field's rows are never random and almost never due north; the road is the one direction we
    // know, so the default heading is the bearing of the spine nearest the field (editor-knobs, 900)
    const headingNear = (cx: number, cy: number): number => {
      let best = Infinity, bestS = 0
      for (let s = 0; s <= curveLen; s += 25) {
        const p = spineAt(s)
        const d = (p.pos.x - cx) ** 2 + (-p.pos.z - cy) ** 2
        if (d < best) { best = d; bestS = s }
      }
      const dir = spineAt(bestS).dir
      return (Math.atan2(dir.x, -dir.z) * 180) / Math.PI
    }
    const centroidOf = (ring: [number, number][]): [number, number] => {
      let x = 0, y = 0
      for (const [px, py] of ring) { x += px; y += py }
      return [x / ring.length, y / ring.length]
    }
    if (T.CROP_AUTO_FARMLAND > 0) {
      for (const lu of manifest.landuse ?? []) {
        if (lu.class !== 'farmland') continue
        const ring = lu.ring as [number, number][]
        if (ring.length < 3) continue
        const [cx, cy] = centroidOf(ring)
        // nothing in the bake says which crop; corn is the mid-Atlantic default and the editor
        // overrides it per polygon. Alternating by ring keeps a run of fields from being uniform.
        const crop: CropType = hash2(cx, cy) < 0.5 ? 'corn' : 'soy'
        fields.push({ polygon: ring, crop, headingDeg: headingNear(cx, cy), spacing: 0 })
      }
    }
    for (const ar of adjustments.list) {
      const a = ar.adjust ?? {}
      if (a.cover !== 'crop') continue
      const ring = ar.polygon as [number, number][]
      const [cx, cy] = centroidOf(ring)
      fields.push({
        polygon: ring,
        crop: asCrop(a.crop ?? null) ?? 'corn',
        headingDeg: a.row_heading_deg ?? headingNear(cx, cy),
        spacing: a.row_spacing_m ?? 0,
      })
    }
    if (fields.length) {
      crops = buildCrops(fields, currentSeason, groundAtWorld, edgeDistanceWorld)
      group.add(crops.group)
    }

    // --- weather -------------------------------------------------------------------------------
    precip = new Precipitation(lite ? 18_000 : 60_000, fog)
    group.add(precip.mesh)
    precip.follow(terrainWeather)
    precip.follow(strip.weatherUniforms)
    for (const bs of branchStrips) precip.follow(bs.weatherUniforms)
    precip.follow(grass.weatherUniforms)
    // what grows on this verge, read off the bake; GRASS_TYPE overrides it from the F6 panel
    const bakedGrassType = cover.grass
    grass.setType(bakedGrassType, GROUND_COVER[cover.open].blades)
    let imp: Impostors | null = null
    let refreshFar = (_skip: Set<number>, _eye?: THREE.Vector3, _fwd?: THREE.Vector3, _pitch?: number) => {}
    if (renderer) {
      // far field: the SAME models as impostors, one quad a tree, re-assigned as the eye moves
      status('baking impostors…')
      near.setSeason(look(currentSeason))
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
      // `shown` holds the indices whose card is currently HIDDEN (the name is the original's).
      let shown = new Set<number>()
      let faded = new Set<number>()
      /**
       * Which far trees draw a card, and how solidly.
       *
       * The card is kept ALIVE for the first `TREE_FADE_M` metres INSIDE the near radius, on top
       * of the procedural model that has already taken over, and dissolves to nothing across that
       * band. That direction is the whole point and it is easy to get backwards: fading the card
       * out on the way IN, before the model appears, makes the tree vanish and then reappear —
       * worse than the pop it was meant to hide. Here the model arrives underneath a solid card,
       * which hides the arrival, and then the card melts off it.
       *
       * The dissolve is a dither in the impostor shader, not alpha blending: 35k camera-facing
       * quads cannot be depth-sorted. The band is measured with the SAME `lodDistance` the near
       * set uses to choose its members, or the fade ring and the swap boundary would be
       * different shapes.
       */
      refreshFar = (skip: Set<number>, eye?: THREE.Vector3, fwd?: THREE.Vector3, pitch = 0) => {
        imp!.clearRanges()
        const band = Math.max(0, T.TREE_FADE_M)
        const inner = T.TREE_NEAR_RADIUS
        // near-set trees that should still show a dissolving card, and how solid it is
        const keep = new Map<number, number>()
        if (band > 0 && eye && fwd) {
          for (const i of skip) {
            const r = t.records[i]
            const d = T.lodDistance(r.x - eye.x, r.z - eye.z, fwd.x, fwd.z, pitch)
            if (d >= inner - band) keep.set(i, Math.min(1, Math.max(0, (d - (inner - band)) / band)))
          }
        }
        const hide = new Set<number>()
        for (const i of skip) if (!keep.has(i)) hide.add(i)
        for (const i of shown) if (!hide.has(i)) imp!.setVisible(i, true, sizes[i])
        for (const i of hide) if (!shown.has(i)) imp!.setVisible(i, false, sizes[i])
        shown = hide
        for (const [i, f] of keep) imp!.setFade(i, f)
        for (const i of faded) if (!keep.has(i)) imp!.setFade(i, 1)
        faded = new Set(keep.keys())
      }
      updateNear = (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch = 0) => {
        if (near.update(eye, false, fwd, pitch)) refreshFar(near.near, eye, fwd, pitch)
        grass.update(eye, fwd, pitch)
        grass.tick(time)
        if (crops) tickCrops(crops.group, time)
        precip?.tick(eye, time)
        imp!.tick()
      }
    } else {
      // no renderer (tests): lollipops for everything
      trees.add(t.crowns, t.trunks)
      updateNear = (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch = 0) => {
        if (near.update(eye, false, fwd, pitch)) t.refresh(near.near)
        grass.update(eye, fwd, pitch)
        grass.tick(time)
        if (crops) tickCrops(crops.group, time)
        precip?.tick(eye, time)
      }
    }
    retune = () => {
      near.invalidate()
      const wantType = T.GRASS_TYPE < 0 ? bakedGrassType : GRASS_TYPES[Math.min(GRASS_TYPES.length - 1, Math.max(0, Math.round(T.GRASS_TYPE)))]
      grass.setType(wantType, T.GRASS_TYPE < 0 ? GROUND_COVER[cover.open].blades : 1)
      grass.invalidate()
      if (roadSignature() !== roadSig) {
        roadSig = roadSignature()
        clearTimeout(roadTimer)
        roadTimer = setTimeout(() => {
          void rebuildRoad()
          grass.invalidate()
        }, 250)
      }
    }
    setSeason = (season: Season) => {
      currentSeason = season
      // the SITE's palette for this season, not the reference one: siteLook shifts it by how much
      // drier or greener this place is than the piedmont the four palettes were drawn against
      const lk = look(season)
      near.setSeason(lk)
      grass.setLook(lk)
      crops?.setSeason(season)
      for (const st of [strip, ...branchStrips]) {
        st.setTint(lk.grass.base.clone().multiplyScalar(2.0).lerp(new THREE.Color(0xffffff), 0.4), imagery ? lk.ground : bare)
        st.setLitter(lk.litter.tint, lk.litter.spread)
      }
      terrainMat.color.copy(imagery && terrainMat.map ? lk.ground : bare)
      if (horizon && (horizon.material as THREE.MeshStandardMaterial).map) (horizon.material as THREE.MeshStandardMaterial).color.copy(lk.ground)
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
      const w = pavedHalfAt((st.s_start + st.s_end) / 2) + 0.6
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
      const width = pavedHalfAt((st.s_start + st.s_end) / 2) * 2
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
  const catalog = await loadCatalog()
  const placementsGroup = await buildPlacements(await loadPlacements(manifest.slug), catalog, groundAtWorld)
  group.add(placementsGroup)
  // the buildings the bake already knew about, as massing under whatever the catalogue places
  status('raising buildings…')
  const built = await buildBuildings(manifest, groundAtWorld)
  group.add(built.group)
  // poles and wires: most of what a rural roadside has, and it was all sitting unused in the bake
  const power = buildPower(manifest, groundAtWorld)
  group.add(power.group)
  // street furniture needs edgeDistance as well as the ground: a signal node sits on the road
  // centreline, and only the viewer knows where the asphalt actually ends
  const furniture = buildFurniture(manifest, groundAtWorld, edgeDistanceWorld)
  group.add(furniture.group)
  const parking = buildParking(manifest, groundAtWorld, edgeDistanceWorld)
  group.add(parking.group)
  const barriers = buildBarriers(manifest, groundAtWorld)
  group.add(barriers.group)
  const sidewalks = buildSidewalks(manifest, groundAtWorld, edgeDistanceWorld)
  group.add(sidewalks.group)
  // authored bridges over the road (structures.json bridge_over)
  structures.add(await buildBridges(overrides, catalog, spineAt, groundAtWorld, (s) => pavedHalfAt(s) * 2))

  // terrain features (terrain-and-data agent): rock on the measured cut faces and outcrops, water in
  // the measured channels. Both stand on groundAt; the water's ripples tick with the near update.
  status('dressing…')
  const rocks = await buildRocks(manifest.cuts, manifest.rock, catalog, groundAtWorld, edgeDistanceWorld)
  group.add(rocks.group)
  const water = buildWater(manifest.water, groundAtWorld)
  group.add(water.group)
  {
    const inner = updateNear
    updateNear = (eye, time, fwd, pitch) => {
      inner(eye, time, fwd, pitch)
      water.tick(time)
    }
  }

  return {
    manifest,
    group,
    layers: { imagery: terrain, trees, grass: grassRef?.mesh, crops: crops?.group, road, horizon, structures, spine, markers, placements: placementsGroup, buildings: built.group, power: power.group, furniture: furniture.group, parking: parking.group, barriers: barriers.group, sidewalks: sidewalks.group, rocks: rocks.group, water: water.group },
    buildingStats: built.stats,
    adjustments,
    treeCount,
    grass: grassRef,
    buildProfile: (mark('done'), buildProfile),
    furnitureCounts: furniture.counts,
    parkingCounts: parking.counts,
    barrierCounts: barriers.counts,
    sidewalkCounts: sidewalks.counts,
    rockCounts: rocks.counts,
    waterStats: { lines: water.lines, areas: water.areas, falls: water.falls, length_m: water.length_m },
    canopyAt: canopyAtRef,
    // what grows here, for probes and the console
    flora,
    cover,
    treePalette: () => nearRef?.palette ?? [],
    /**
     * The silhouette every measured tree drew, as a histogram — the whole species assignment,
     * counted. `legacy` replays the rule this replaced (canopy height and a hash over five fixed
     * hardwood presets, trees.ts before 2026-09-21) over the same trees, so a probe can print the
     * before and the after side by side rather than describing the change.
     */
    treeSpecies: (legacy = false) => {
      const pal = nearRef?.palette ?? []
      const n: Record<string, number> = {}
      const LEGACY = ['Oak Medium', 'Ash Medium', 'Aspen Medium', 'Oak Large', 'Ash Small']
      if (legacy) for (const k of LEGACY) n[k] = 0
      else for (const p of pal) n[p.id] = 0
      for (let i = 0; i < treeRecords.length; i++) {
        const t = treeRecords[i]
        let id: string
        if (legacy) {
          const hash = (i * 2654435761) >>> 0
          id = LEGACY[t.h > 22 ? (hash % 2 === 0 ? 3 : 0) : t.h < 8 ? 4 : hash % 3]
        } else id = pal[nearRef?.variantFor(t, i) ?? 0]?.id ?? '?'
        n[id] = (n[id] ?? 0) + 1
      }
      return n
    },
    cropRows: crops?.counts ?? {},
    setWeather: (w: Weather) => precip?.set(w),
    get weather() {
      return { current: precip?.current ?? ('clear' as Weather), settled: precip?.settled ?? 0, particles: precip?.count ?? 0 }
    },
    updateNear,
    retune,
    setSeason,
    groundAt: groundAtWorld,
    edgeDistance: edgeDistanceWorld,
    treesNear: treesNearWorld,
    terrain,
    heightAt,
    spineAt,
    setImagery: (on) => {
      terrainMat.map = on ? imagery : null
      terrainMat.color.copy(on && imagery ? look(currentSeason).ground : bare)
      terrainMat.needsUpdate = true
    },
    setWire: (on) => {
      terrainMat.wireframe = on
    },
    /** the canopy blanket is built on the first tick, not on load — see `makeCanopy` */
    setCanopy: (on) => {
      if (on && !canopy && makeCanopy) canopy = makeCanopy()
      if (canopy) canopy.visible = on
      return canopy
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

function cutHorizon(geo: THREE.BufferGeometry, demBbox: [number, number, number, number], cell: number, heightAt: (x: number, y: number) => number) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [x0, y0, x1, y1] = demBbox
  const removed = new Uint8Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = -pos.getZ(i) // site frame
    if (x < x0 || x > x1 || y < y0 || y > y1) continue
    const deep = x > x0 + cell * 1.5 && x < x1 - cell * 1.5 && y > y0 + cell * 1.5 && y < y1 - cell * 1.5
    if (deep) removed[i] = 1
    else pos.setY(i, heightAt(x, y) - 3.0)
  }
  const idx = geo.getIndex()!
  const keep: number[] = []
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    if (removed[a] || removed[b] || removed[c]) continue
    keep.push(a, b, c)
  }
  geo.setIndex(keep)
  pos.needsUpdate = true
  geo.computeVertexNormals()
}

/** Free the GPU side of a subtree (geometry only: materials are shared surface sets). */
function disposeDeep(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
  })
}
