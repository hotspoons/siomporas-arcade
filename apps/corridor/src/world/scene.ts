// Build a three.js scene from a site manifest. World frame: X = east, Y = up (metres NAVD88),
// Z = south — i.e. (x, y, z)_site -> (x, z, -y)_three, right-handed with Y up so nothing in
// three's camera/controls code has to be told about Z-up.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { inside } from './polygon'
import { VegCover } from '../lod/vegmask'
import { landuseZone, zoneOfRoad } from './zoning'
import * as T from '../tuning'
import { scaledMs } from './streamscale'
import { Anchor } from '@apex/engine/geo/wgs84'
import { RasterFrame } from '@apex/engine/geo/raster'
import { makeSplatFading, type SplatMaskUniforms } from '../visuals/splatmask'
import { installRoadClip, RoadCover } from '../visuals/roadcover'
import { ImageryStream, PyramidSet, TileSet, loadTiles } from '../lod/tiles'
import { PyramidStream } from '../lod/pyramidstream'
import type { GridArrays } from '../lod/gridarrays'
import { loadBakedTexture } from '../assets/textures'
import { DATA_BASE, decodeHeights, decodeScalar, loadImage, loadVectorTile, vectorTileCacheSize, type Layer, type Manifest, type Structure, bilinear } from './site'
import { NearTrees, type TreeRecord } from './trees'
import { Impostors } from '../lod/impostors'
import { Grass } from './grass'
import { siteLook, type Season } from '../visuals/season'
import { GRASS_TYPES, GROUND_COVER, floorTexture, siteCover } from './groundcover'
import { loadFlora, type Flora } from './flora'
import { CROP_TYPES, buildCrops, setCropLight, tickCrops, type CropType, type Field as CropField } from './crops'
import { ACCUM_PARS, Precipitation, WEATHER, accumUniforms, type Weather, type WeatherLook } from '../visuals/weather'
import { buildStrip, refreshNormals, sinkUnderStrips } from './strip'
import { chunkStations } from './branchchunks'
import { deckRibbon, isDeck } from './overpass'
import { Budget } from './budget'
import { Adjustments, NEUTRAL as NEUTRAL_ADJ } from './adjust'
import { buildPlacements, loadCatalog, loadPlacements } from './placements'
import { buildBuildings, buildRoadIndex, buildTiming, type TexturePool } from './buildings'
import { loadSurfacesDoc, resolveSurfaceSets, type SurfacesDoc } from '../assets/surfacesdoc'
import { buildPower } from './power'
import { buildBarriers, buildFurniture, buildSidewalks, sidewalkCover } from './furniture'
import { buildBlades, buildCrosswalks, buildLaneArrows, buildSignals, buildStopBars, junctionPaintCut, loadJunctionFacts, type ArrowsResult, type BarsResult, type CrosswalksResult } from './intersections'
import { buildParking, parkingCover } from './parking'
import { buildBridges, flattenSpine, loadStructureOverrides, suppressed } from './structures'
import { isKerbed, loadSurfaceSets, overpassMesh, pavedOffset, pavedWidth, repaintMarkings, roadMesh, roadMeshPaced, stations, taperedLanes, treesFromCanopy, type SurfaceSet } from './props'
import { STYLE, styled, type Style } from '../visuals/style'
import { buildRocks, type RocksResult } from './rocks'
import { buildWater } from './water'
import { siteProjector } from '../game/move/minimap'
import { injectShade } from '../visuals/shading'
import { reliefManifest } from '../visuals/relief'
import { TreeShadowCasters } from '../lod/treeshadows'

let surfaceSets: Record<string, SurfaceSet> | null = null

/**
 * Streamed vector tiles are fetched *after* `reliefManifest(manifest)` ran at load, so a cell's
 * heights have to be exaggerated once, the first time the tile is seen. `loadVectorTile` caches the
 * parsed object, so a tile the building pump and the branch pump both reach is relieved exactly once.
 */
const relievedCells = new WeakSet<object>()
function relieveCell(files: Record<string, unknown>): void {
  if (relievedCells.has(files)) return
  relievedCells.add(files)
  reliefManifest(files as unknown as Manifest)
}

export const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y)

/** what one `updateNear` cost, by layer, in ms */
export interface NearPerf {
  roadCover: number
  trees: number
  /** the parts of `trees`: the planter (replant + crescent pump), the near set's reseat, the far cards, the shadow casters */
  treesPlant: number
  /** inside `treesPlant`: the crescent pump, and seating what it placed (the grids, the near set, the far cards) */
  treesPump: number
  treesPatch: number
  treesNear: number
  treesFar: number
  treesShadow: number
  grass: number
  /** crops, precipitation, impostor uploads */
  other: number
  water: number
  stream: number
  pyr: number
  /** the per-level visibility pass: roads, houses, trees, grass, crops against the tile under the eye */
  lod: number
  /** the grading pump's scheduling (the units themselves run off-frame) */
  grade: number
  veg: number
  total: number
}

export interface Site {
  manifest: Manifest
  group: THREE.Group
  layers: { imagery?: THREE.Mesh; trees?: THREE.Group; grass?: THREE.Group; crops?: THREE.Group; road: THREE.Group; horizon?: THREE.Mesh; structures: THREE.Group; spine: THREE.Group; markers: THREE.Group; placements: THREE.Group; buildings: THREE.Group; power: THREE.Group; furniture: THREE.Group; parking: THREE.Group; barriers: THREE.Group; sidewalks: THREE.Group; rocks: THREE.Group; water: THREE.Group; signals: THREE.Group; stopbars: THREE.Group; blades: THREE.Group }
  /** how many footprints were massed, and how many had a real measured height */
  buildingStats: { count: number; gabled: number; fromLidar: number; dressed: number }
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
  /** signal junctions that cycle, and the lit lenses driving them */
  signalCounts: { junctions: number; lit: number; masts: number; phases: number }
  /** painted stop lines */
  stopBarCounts: { bars: number; metres: number; clipped: number; noRoad: number }
  /** street name blades and the corners they stand on */
  bladeCounts: { junctions: number; blades: number; truncated: number; fellBack: number; noCorner: number; atlas: string }
  /** terrain-and-data: rock instances placed per rock type, and what water was drawn (for probes) */
  rockCounts: Record<string, number>
  waterStats: { lines: number; areas: number; falls: number; length_m: number }
  /** what the junction paint drew, for probes: stop lines, ladders, lane arrows */
  junctionPaint: { bars: BarsResult['counts']; crosswalks: CrosswalksResult['counts']; arrows: ArrowsResult['counts'] }
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
  /** how the trees were planted and replanted: cell, radius, centre, count, and whether the budget capped it */
  treePlanting: () => { count: number; cellM: number; radius: number; centre: [number, number]; capped: boolean; replants: number; lastMs: number; pending: number }
  /**
   * The far-field invariant, read straight off the instance matrices: a tree the near set is
   * drawing as a MODEL must not also be drawing a CARD, unless it is inside the dissolve band.
   * `doubled` is the number that are — a flat billboard standing in a procedural tree.
   */
  /**
   * The tree LOD handover, and whether the GPU has been told about it.
   *
   * `doubled` counts cards standing in procedural models — but it is computed from the CPU array,
   * which is right even when the screen is wrong. `uploads` is the other half: `sent` lagging
   * `marked` means a write never left the process, which is the failure that looks intermittent
   * and clears on a reload.
   */
  treeCards: () => { nearSet: number; cards: number; inBand: number; doubled: number; band: number; replants: number; uploads: Record<string, number | boolean> | null }
  /** crop rows built per field, by crop type (probes read this) */
  cropRows: Record<string, number>
  /** what is falling and what has settled */
  setWeather: (w: Weather) => void
  /** the weather the sky should show, including a taper that is still in progress */
  weatherLook: () => WeatherLook
  weatherBlending: () => boolean
  weather: { current: Weather; settled: number; particles: number; wetness: number }
  /** per-frame: move the near-field tree models and the grass ring to follow the eye; fwd/pitch shape the LOD footprint */
  updateNear: (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch?: number) => void
  /** what the last `updateNear` cost, by layer, ms — the perf panel and the bridge read it */
  nearPerf: NearPerf
  /** a knob changed: re-pick trees and re-seed grass on the next frame */
  retune: () => void
  /** the world's textures changed (World tab): the road is redrawn with them; buildings on the next load */
  setSurfaces: (doc: SurfacesDoc) => void
  /** the world's textures as loaded, for the World tab */
  surfaces: () => SurfacesDoc
  /** recolour everything living */
  setSeason: (season: Season) => void
  /** the palette: realistic is the bake as measured; anything else is a place that is not this one */
  setStyle: (style: Style) => void
  /** the scene's day/night light level and colour, for the shaders that do their own lighting:
   * the grass, the crops and the tree impostors, which would otherwise glow in the dark.
   * `sun` is the real sun direction, so the grass and the fields follow the sky instead of a
   * fixed corner of it. */
  setLight: (level: number, tint: THREE.Color, sun?: THREE.Vector3) => void
  /**
   * How wet the world looks, 0…1 (weather.ts ramps it). Water lowers a surface's roughness, which
   * is the whole effect: with the sky in an environment map a wet road reflects it, and at night a
   * low roughness is what turns headlights into a long streak down the tarmac. Only the PHYSICAL
   * materials take it — the strip, the terrain and the grass already darken through the weather's
   * own shader chunk.
   */
  setWet: (wet: number) => void
  /** world-frame ground height under x,z: the fine strip near the road, the DEM beyond */
  groundAt: (x: number, z: number) => number | null
  /**
   * The ground the PHYSICS should stand on at a grade-separated crossing: like `groundAt`, but it
   * follows the LOWER carriageway where one road passes over another, because a heightfield is one
   * height per column. The upper carriageway is carried by `decksNear` instead. Off a crossing the
   * two agree exactly.
   */
  physGroundAt: (x: number, z: number) => number | null
  /**
   * The elevated carriageways near a point as drivable trimesh ribbons in the SITE frame (x east,
   * y north, z up), keyed by carriageway — the deck colliders for `physGroundAt`'s omitted levels.
   */
  decksNear: (x: number, z: number, r: number) => { key: string; positions: Float32Array; indices: Uint32Array }[]
  /** signed distance to the nearest pavement edge (negative on the pavement) */
  edgeDistance: (x: number, z: number) => number
  /** what the grass generator is told at world (x, z): -1 on pavement, a lot, a walk or air-photo paving; else metres from the nearest road. For probes. */
  /**
   * Hand the built world the seam: where a capture has taken over, it dissolves away.
   *
   * Every ordinary lit material gets the dithered discard through `onBeforeCompile`, and the
   * shaders that light themselves (grass, the tree cards, the road paint) get the uniforms
   * directly. Called once when a site's captures are attached; a site with none never calls it
   * and nothing in the built world changes at all.
   */
  setSplatMask: (u: SplatMaskUniforms) => { materials: number }
  grassRoadDistance: (x: number, z: number) => number
  /** true where grass is forbidden by a MASK rather than by the road geometry — see scene.ts */
  grassBlocked: (x: number, z: number) => boolean
  /** the full edge record at world (x, z): signed distance to the nearest pavement edge, which road (`who`, < 0 for a driveway or bulb), its surface height and along-track s. For probes. */
  edgeInfo: (x: number, z: number, exclude?: number, roadsOnly?: boolean) => { d: number; who: number; y: number; s: number; gx: number; gz: number }
  /** every carriageway whose pavement covers a point, lowest first — QA for a crossing */
  edgeLevels: (x: number, z: number) => { who: number; y: number; d: number }[]
  /** kept (trimmed lawn) or rural (mown shoulder, tall grass) at world (x, z), from landuse then road class — see zoning.ts */
  zoneAt: (x: number, z: number) => 'kept' | 'rural' | null
  /**
   * WHICH ROAD IS THIS. The name, ref and class of the carriageway nearest a world point, from the
   * same station grid the car already stands on — so what the HUD says you are driving on is the
   * road the physics thinks you are on, not a second opinion.
   */
  roadAt: (x: number, z: number) => { name: string | null; ref: string | null; highway: string | null; d: number } | null
  /** how many junctions had an inferior road re-graded to meet the superior one, and the largest step closed (m) */
  junctionMeet: { junctions: number; warped: number; maxStep: number; noTarget: number }
  /** the vegetation mask: tile photos classified so far, of those with a photo */
  vegCover: () => { loaded: number; total: number; inFlight: number; failed: number; lastMs: { fetch: number; decode: number; classify: number } | null }
  /** trees within r of world x,z as [x, z, trunkRadius] */
  treesNear: (x: number, z: number, r: number) => [number, number, number][]
  terrain: THREE.Mesh
  /** imagery streaming counts on a tiled network, null on a corridor site */
  tiles: (() => ImageryStream['counts']) | null
  /** the stream itself, so its ring and ceiling can be swept from a probe or the console */
  tileStream: ImageryStream | null
  /** LOD pyramid residency — held/pending/bytes and a count per level, null on a flat bake */
  pyramid: (() => PyramidStream['counts']) | null
  /** the pyramid stream itself, so a probe can force an update at a chosen eye */
  pyramidStream: PyramidStream | null
  /** how many parsed vector tiles are cached; the LRU cap bounds this on a long drive */
  vtileCache: () => number
  /** accumulated building-build timings, so a probe can see massing vs dressing vs normals */
  buildingsTiming: () => typeof buildTiming
  /** ground height (m) at site x,y from the DEM layer */
  heightAt: (x: number, y: number) => number
  /** the lowest elevation (m) among the terrain tiles now held; the sea plane's visibility gate */
  lowestGround: () => number
  /** the lazy grading: how much of the site's strips and buildings exist yet, and what they cost */
  graded: () => { built: number; total: number; pendingNear: number; strips: number; buildings: number; ms: number; worstMs: number; worst: string }
  /**
   * The road/branch streaming queue as the pump sees it: what it is building now, what is queued
   * within `STREAM_BUILD_M` of the eye (broken down by kind), and how much wall time the junction
   * meet is eating. A probe samples this while driving fast to catch roads lagging the car.
   */
  roadStream: () => {
    pumping: boolean
    current: string
    pendingNear: number
    nearBranch: number
    nearStreet: number
    nearBuildings: number
    nearest: { key: string; d: number }[]
    branches: number
    meet: { calls: number; lastMs: number; worstMs: number; totalMs: number; branches: number }
  }
  /** point + travel direction on the spine at along-track s (metres) */
  spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }
  /**
   * EVERY DRIVEABLE CHAIN, the spine first.
   *
   * `spineAt` answers for one road, and a network site is hundreds — so anything that wants to put
   * something ON a road (a stunt fixture, a gate, a traffic plan) could only ever find the primary
   * one. Rich, 2026-09-29: *"trying to place it on a secondary road in a network, it always goes to
   * the spine road"*. It did, because the spine was the only thing anybody could ask about.
   *
   * Index 0 is the spine, and the rest are the branches in the order the manifest lists them, which
   * is the numbering `OnRoad.chain` already uses.
   */
  /**
   * Every drivable chain: the spine at index 0, then the branches. `at(s)` answers in three's
   * frame (x east, y up, z south). `lanes`, `twoWay`, `half` (paved half-width, m) and `highway`
   * are what a traffic plan needs to put cars in lanes and a race needs to lay a gate across the
   * road; a chain that has not been measured reports the road builder's own defaults.
   */
  chains: () => { index: number; name: string; ref: string | null; length_m: number; lanes: number; twoWay: boolean; half: number; highway: string | null; at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 } }[]
  /** the terrain's texture, so the imagery toggle can swap it in and out */
  setImagery: (on: boolean) => void
  /** draw the terrain as a wireframe */
  setWire: (on: boolean) => void
  /** the canopy blanket: 72 MB and 1.05 M vertices, so it is not built until this is first called true */
  /**
   * Hide the baked road over these stations and rebuild it — see the note on the implementation.
   *
   * KNOWN GAP: only chain 0, the spine, is rebuilt. A branch's road is built lazily per chunk as
   * the eye reaches it and cached, so suppressing one means invalidating that cache too. A fixture
   * on a branch therefore links, renders and drives, with the baked tarmac still under it.
   */
  setRoadSkip: (fn: ((chain: number, s: number) => boolean) | null) => void
  /**
   * Ground where scenery must not exist — the footprints of this world's stunt fixtures.
   *
   * Trees stop being indexed for collision immediately, so a trunk inside a loop cannot be hit, and
   * are replanted without them so it cannot be seen either. `sceneryCleared` is the same question
   * for anything else that plants itself, which is how the props keep out.
   */
  setSceneryClear: (polys: [number, number][][]) => void
  sceneryCleared: (x: number, y: number) => boolean
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
function sampler(f: Field, up = false) {
  const [w, h] = f.layer.size
  if (f.rf) {
    const rf = f.rf
    // `up` is for HEIGHT rasters: their stored value is geodetic and the world renders on the
    // ellipsoid, so the lookup returns the curved up (the mesh beside it is placed the same way).
    // Canopy is a height ABOVE the ground, not a height on it, so it is asked for without `up`.
    return up
      ? (x: number, y: number) => { const g = rf.toGrid(x, y); return rf.toEnuUp(g[0], g[1], bilinear(f.data, w, h, g[0], g[1])) }
      : (x: number, y: number) => { const g = rf.toGrid(x, y); return bilinear(f.data, w, h, g[0], g[1]) }
  }
  const [xmin, , , ymax] = f.layer.bbox
  return (x: number, y: number) => bilinear(f.data, w, h, (x - xmin) / (w * f.layer.res), (ymax - y) / (h * f.layer.res))
}

/**
 * A regular grid mesh over a height field, sampled every `stride` cells.
 *
 * THE MESH MUST REACH THE RASTER'S EDGE. Two things used to stop it, and together they left an
 * 8 m trench along the east and south side of every 1 km tile — Rich's "big blue water seams
 * between tiles" (2026-09-26), blue because the sea plane at 0 m showed through the gap. Found by
 * measurement, not by looking: the DEMs of two neighbouring tiles agree along their shared column
 * to 0.01 m, so the data was fine; the live meshes were 100 x 100 vertices from 500 x 500 cells,
 * stride 5, and the last vertex sat at cell 495 — the last four cells were never meshed.
 *
 *   1. `floor((w-1)/stride) + 1` columns dropped the remainder. It is `ceil` now, and the final
 *      column is pinned to cell w-1 whatever the stride.
 *   2. Every vertex sat at its cell CENTRE, so even a full grid stopped half a cell short of the
 *      raster edge on all four sides. The outermost vertices now sit ON the edge (u = 0 and 1),
 *      carrying the edge cell's height: a half-cell stretch of the edge texel, exact everywhere
 *      else, and two neighbours now share a line instead of leaving one between them.
 */
function gridGeometry(f: Field, stride: number, lift: (i: number, r: number, c: number) => number, color?: (i: number) => [number, number, number], uv1At?: (x: number, y: number) => [number, number]) {
  const [xmin, , , ymax] = f.layer.bbox
  const [w, h] = f.layer.size
  const rf = f.rf
  const enu = [0, 0, 0]
  const cols = Math.ceil((w - 1) / stride) + 1
  const rows = Math.ceil((h - 1) / stride) + 1
  const pos = new Float32Array(cols * rows * 3)
  const uv = new Float32Array(cols * rows * 2)
  const uv1 = uv1At ? new Float32Array(cols * rows * 2) : null
  const col = color ? new Float32Array(cols * rows * 3) : null
  let k = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rr = r === rows - 1 ? h - 1 : Math.min(h - 1, r * stride)
      const cc = c === cols - 1 ? w - 1 : Math.min(w - 1, c * stride)
      const i = rr * w + cc
      // cell centres inside; the raster's own edge on the rim
      const u = c === 0 ? 0 : c === cols - 1 ? 1 : (cc + 0.5) / w
      const v = r === 0 ? 0 : r === rows - 1 ? 1 : (rr + 0.5) / h
      const z = f.data[i] + lift(i, rr, cc)
      if (rf) {
        // geodetic from the lattice, then the ellipsoid: the curvature is not a correction added
        // afterwards, it is what the transform returns
        rf.toEnu(u, v, z, enu)
        pos[k * 3] = enu[0]
        pos[k * 3 + 1] = enu[2]
        pos[k * 3 + 2] = -enu[1]
      } else {
        pos[k * 3] = xmin + u * w * f.layer.res
        pos[k * 3 + 1] = z
        pos[k * 3 + 2] = -(ymax - v * h * f.layer.res)
      }
      uv[k * 2] = u
      uv[k * 2 + 1] = 1 - v
      if (uv1 && uv1At) {
        // where this vertex falls in ANOTHER raster (the site overview), in that raster's own
        // normalised coordinates: exact through the lattices, so a placeholder drawn from it sits
        // on the same ground as the tile's own imagery will
        const q = uv1At(pos[k * 3], -pos[k * 3 + 2])
        uv1[k * 2] = q[0]
        uv1[k * 2 + 1] = q[0] < 0 ? -1 : 1 - q[1] // the (-1, -1) sentinel means "no data here"

      }
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
  if (uv1) g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2))
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeVertexNormals()
  return g
}

/** Pick a stride so a grid stays under `maxVerts` vertices. */
const strideFor = (layer: Layer, maxVerts: number) => Math.max(1, Math.ceil(Math.sqrt((layer.size[0] * layer.size[1]) / maxVerts)))

/** Wrap a terrain grid the decode worker already built, so no vertex is touched on the main thread. */
function geometryFromGrid(g: GridArrays): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2))
  geo.setAttribute('normal', new THREE.BufferAttribute(g.norm, 3))
  geo.setIndex(new THREE.BufferAttribute(g.idx, 1))
  return geo
}

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


/**
 * How many lanes a branch road carries.
 *
 * `Number(br.lanes) > 0 ? … : 2` looks harmless and was silently drawing almost the whole road
 * network two lanes wide. The bake collapses a chain's per-way `lanes` tags into a sorted SET OF
 * STRINGS, so a five-kilometre trunk road that is three lanes for most of its length and widens
 * at its junctions arrives as `["3","4","5","6","7"]`. `Number(that)` is NaN, `NaN > 0` is false,
 * and the road came out at the default. Measured on crofton-triangle: 397 of 427 branches carry
 * `null`, 10 carry an array, and only 20 carry a plain number — so US 3 through Crofton, which
 * Rich drives, was drawn at two lanes (2026-09-27).
 *
 * The SMALLEST member of that set is the honest reading of it: the through count, the width the
 * road holds for most of its length. Taking the largest would smear a junction's turn pockets
 * over five kilometres. The real fix is per-station lane counts for branches, the way the spine
 * already has them (`manifest.spine.segments[].tags.lanes` and `taperedLanes`) — that is a bake
 * change, and this is what the viewer can do correctly with what it is given today.
 */
function branchLanes(v: unknown, fallback = 2): number {
  if (typeof v === 'number') return v > 0 ? v : fallback
  if (typeof v === 'string') {
    const n = Number(v)
    return n > 0 ? n : fallback
  }
  if (Array.isArray(v)) {
    const ns = v.map(Number).filter((n) => n > 0)
    return ns.length ? Math.min(...ns) : fallback
  }
  return fallback
}

/**
 * `plantWhole`: the editor's ask. The game plants trees in a disc around the eye and replants as
 * it moves; the editor never moves the eye that way (no `updateNear`), so its preview was a
 * fixed disc around the photo station with bare canopy beyond. Whole-bake planting at a coarser
 * cell covers the area within the same budget: 120k trees at 12 m is 17 km² of full canopy.
 */
export interface BuildSiteOpts {
  plantWhole?: boolean
  /**
   * Where this visit starts, in the Three.js frame (x east, z south). The level's start point,
   * else the world's home. The streamed path builds a kilometre around this and leaves the rest
   * for the pump. Absent, the bake's photo station is the centre, which is the old default.
   */
  focus?: { x: number; z: number }
}

export async function buildSite(manifestIn: Manifest, rawStatus: (s: string) => void, lite = false, renderer?: THREE.WebGLRenderer, fog: THREE.FogExp2 | null = null, initialSeason: Season = 'summer', initialStyle: Style = 'realistic', opts: BuildSiteOpts = {}): Promise<Site> {
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
  // Finer than a phase: named SUB-SPANS (the Grass constructor, each street builder). Kept OUT of
  // buildProfile so bootMs stays the sum of the phases and cannot double-count. Read back as
  // window.__bootDetail, or in the `[boot:detail]` line.
  const bootDetail: { phase: string; ms: number }[] = []
  ;(globalThis as { __bootDetail?: unknown }).__bootDetail = bootDetail
  const detail = <T>(name: string, fn: () => T): T => {
    const t0 = performance.now()
    const r = fn()
    bootDetail.push({ phase: name, ms: Math.round(performance.now() - t0) })
    return r
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
  let currentStyle: Style = initialStyle
  // the site's own palette for the season, then the style over it — see style.ts
  const look = (s: Season) => styled(siteLook(s, flora), currentStyle)
  const overrides = await loadStructureOverrides(manifest.slug)
  // authored `flatten` intervals rewrite the spine's grade before anything is built from it
  if (overrides.length) manifest = { ...manifest, spine: { ...manifest.spine, coords: flattenSpine(manifest.spine.coords, overrides) }, structures: suppressed(manifest.structures, overrides) }
  const demImg = await loadImage(base + L.dem.file)
  const dem: Field = framed(L.dem, decodeHeights(demImg, L.dem), anchor)
  const overviewHeight = sampler(dem, true)

  // A network bake keeps this 8 m DEM as the OVERVIEW and puts the real 2 m heights in tiles. Those
  // are decoded up front, not streamed: every height lookup below — the strip, the trees, the
  // grass, the car — happens on the first frame, and a height that has not arrived is a hole, not
  // a coarser LOD. The overview stands in wherever no tile was baked, which is most of a hull.
  // A PYRAMID bake supersedes the flat tile list: quadtree tiles at several levels, loaded and
  // evicted against the camera instead of decoded up front. `pyrSet` answers heights from the
  // finest resident tile and falls back to the overview wherever nothing is held — which is what
  // dissolves the objection the flat loader was built on, that a height not yet arrived is a hole.
  let pyrSet: PyramidSet | null = null
  if (L.pyramid && anchor) {
    // The overview canopy is assigned when the CHM decodes, which is after this. The wrapper reads
    // whatever it is then, so a tree measured before a leaf tile arrives still sees the 8 m woods
    // instead of a hole that gets cached forever.
    pyrSet = new PyramidSet(L.pyramid.zmin, L.pyramid.zmax, overviewHeight, (x, y) => overviewCanopy(x, y))
  }

  /** the 8 m overview canopy; the tiles' 2 m CHM is preferred wherever a tile is resident */
  let overviewCanopy: (x: number, y: number) => number = () => 0
  let tileSet: TileSet | null = null
  if (L.tiles && anchor && !pyrSet) {
    status('decoding terrain tiles…')
    // the tiles carry a 2 m CHM; the 8 m overview is only the fallback outside them (the closure
    // reads `overviewCanopy`, which the canopy decode sets further down)
    tileSet = new TileSet(L.tiles.size_m, overviewHeight, (x, y) => overviewCanopy(x, y))
    // Budgeted: four hundred packs decoded in one call stack is the same freeze the branch
    // builder had, and the budget already knows not to wait on a frame that a hidden tab will
    // never deliver.
    const b = new Budget(8)
    await loadTiles(base, L.tiles, anchor, tileSet, (d, n) => status(`terrain tiles ${d}/${n}…`), () => b.tick())
    if (!tileSet.tiles.length) {
      console.warn(`${manifest.slug}: tile index lists ${L.tiles.list.length} tiles, none loaded — falling back to the overview`)
      tileSet = null
    }
  }
  const heightAt = pyrSet ? pyrSet.heightAt : tileSet ? tileSet.heightAt : overviewHeight

  /**
   * The lowest elevation of the terrain now HELD, in metres. This is the sea plane's gate: a water
   * plane at `WATER_LEVEL_M` that is under every active tile is buried, so it need not be drawn and
   * need not be mirrored. The pyramid loads and evicts tiles against the camera, so the floor rises
   * as the eye leaves the low ground and falls when the coast streams back in; the flat loaders hold
   * everything and answer a constant. This is a live read, asked each frame the water is placed.
   */
  const lowestGround = (): number => {
    let lo = Infinity
    // the stored zmin is geodetic; the world renders on the ellipsoid, so a tile's real floor is
    // its corners' ENU up (the curvature can put it tens of metres lower at the far edge of a
    // network). Read the frame, not the raw value.
    const floorOf = (t: { dem: { layer: { zmin?: number | null }; rf: { toEnuUp(u: number, v: number, h: number): number } } }) => {
      const z = t.dem.layer.zmin
      if (z == null) return
      const rf = t.dem.rf
      const v = Math.min(rf.toEnuUp(0, 0, z), rf.toEnuUp(1, 0, z), rf.toEnuUp(0, 1, z), rf.toEnuUp(1, 1, z))
      if (v < lo) lo = v
    }
    if (pyrSet) {
      for (const t of pyrSet.tiles.values()) floorOf(t)
    } else if (tileSet) {
      for (const t of tileSet.tiles) floorOf(t)
    } else if (typeof L.dem?.zmin === 'number') {
      lo = L.dem.zmin
    }
    return lo
  }

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
    // A .ktx2 CARRIES its mipmaps (12 of them for the overview) — asking three to generate more
    // for a compressed texture is a no-op at best and drops the chain at worst. Only the
    // uncompressed paths need it.
    tex.generateMipmaps = !(tex as unknown as { isCompressedTexture?: boolean }).isCompressedTexture
    tex.minFilter = THREE.LinearMipmapLinearFilter
    imagery = tex

    // NOTE: minimap.ts fetches layers.naip.file separately and that is not waste — it draws the
    // imagery into a 2D canvas, which cannot read a GPU-compressed texture.
  }
  // The per-tile vegetation mask (vegmask.ts). It used to be a second gate on the grass on top of
  // the ground's own "is this verge?" — asking the air photo "is this green?" and winning over whole
  // grass-textured medians and verges (Rich 2026-10-04). The ground texture decides now, so this is
  // streamed only for diagnostics; nothing gates the grass on it.
  let veg: VegCover | null = null
  const bare = new THREE.Color(0x6f6a5a)
  /*
   * THE BASE TEXTURE. Every DEM surface should read as ground even when its own imagery has not
   * streamed — a tile past the overview's edge, or one whose photo failed. Left bare it is a flat
   * colour that reads as a hole (and the coarse imagery shows from below where the fine world is
   * sunk under a strip). The fallback is the same turf the verge uses, sampled top-down by world
   * position so it tiles across any tile regardless of its uv; which surface class it is is the
   * one thing to change to re-skin it. Rich, 2026-10-06.
   */
  const TERRAIN_FALLBACK_CLASS = 'grass_rough'
  const terrainFallbackTex = { value: null as THREE.Texture | null }
  const terrainFallbackOn = { value: 0 }
  /** Point the terrain's base texture at a surface-set class's own map (see blocks below). */
  const applyTerrainFallback = (sets: Record<string, SurfaceSet> | undefined): void => {
    const fb = (sets?.[TERRAIN_FALLBACK_CLASS]?.material as THREE.MeshStandardMaterial | undefined)?.map ?? null
    if (!fb) return
    fb.wrapS = fb.wrapT = THREE.RepeatWrapping
    terrainFallbackTex.value = fb
    terrainFallbackOn.value = 1
  }
  // the coarse terrain takes the settled layer as well, or snow stops at the strip's rim
  const terrainWeather = accumUniforms()
  /** one object shared by every terrain material: a style's hold on the photo (0 as shot, 1 grey) */
  const terrainDesat = { value: STYLE[initialStyle].desaturate }
  /**
   * Every terrain surface — the overview and each tile — is the same material with its own map.
   *
   * `fallbackAllowed` is the base texture's second gate, and the pyramid is why it exists. Its
   * coarse levels are the BACKING STORE: a finer tile arrives and `seat()` drops the parent eight
   * metres under it (tuning PYR_DROP_M). Painting turf on those dropped parents put grass at the
   * wrong height — visible as grass standing in a hole the moment a leaf was missing (Rich,
   * 2026-10-06). Only the TOP level (the leaf DEM, `z === zmax`) and the inferred coarse ground
   * (the overview/horizon, which is never dropped) may wear it. Where a real texture exists it is
   * always shown: the shader guards the sample with `#ifndef USE_MAP`, so a photo that streams in
   * after the material was built simply wins.
   */
  const terrainMaterial = (map: THREE.Texture | null, fallbackAllowed = true) => {
    const m = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : bare, roughness: 1, metalness: 0 })
    // Per tile, so the legend can tint this mesh without touching any other. The objects are the
    // uniform values: writing them takes effect next frame, with no shader rebuild.
    const lodTint = new THREE.Color(0xffffff)
    const lodOn = { value: 0 }
    m.userData.lodTint = lodTint
    m.userData.lodOn = lodOn
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, terrainWeather)
      shader.uniforms.uBare = { value: bare }
      shader.uniforms.uDesat = terrainDesat
      shader.uniforms.uLodTint = { value: lodTint }
      shader.uniforms.uLodOn = lodOn
      // The base texture only stands in where there is no photo. `uFallback` is the shared turf (it
      // arrives with the surface sets, after this closure is built, so the object is shared and its
      // value read at draw time); `on` is 0 for any material that carries its own imagery, or one
      // whose ground is a dropped coarse level.
      shader.uniforms.uFallback = terrainFallbackTex
      shader.uniforms.uFallbackOn = map || !fallbackAllowed ? { value: 0 } : terrainFallbackOn
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWWorld;\nvarying vec3 vWNormal;\nvarying vec2 vLodUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWWorld = (modelMatrix * vec4(position, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);\nvLodUv = uv;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>\nvarying vec3 vWWorld;\nvarying vec3 vWNormal;\nvarying vec2 vLodUv;\nuniform vec3 uBare;\nuniform float uDesat;\nuniform vec3 uLodTint;\nuniform float uLodOn;\nuniform sampler2D uFallback;\nuniform float uFallbackOn;\n${ACCUM_PARS}`)
        // a placeholder tile past the overview's edge carries the (-1, -1) uv sentinel: bare ground
        // there, not the overview's last row stretched across the rim; then the style's
        // desaturation of the photo (the material colour, the ground tint, multiplies after).
        // The base texture is a FALLBACK, so it may only paint a material that has no map at all —
        // `USE_MAP` is compile-time, and three rebuilds the program when a photo arrives, so a tile
        // born bare and later textured stops falling back without any state to keep in step.
        .replace('#include <map_fragment>', `#include <map_fragment>\n#ifndef USE_MAP\nif (uFallbackOn > 0.5) diffuseColor.rgb = texture2D(uFallback, vWWorld.xz * 0.35).rgb;\n#endif\n#ifdef USE_MAP\nif (vMapUv.x < -0.01) diffuseColor.rgb = uBare;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.5, 0.2))), uDesat);\n#endif\ndiffuseColor.rgb = applyWeather(diffuseColor.rgb, normalize(vWNormal), vWWorld);`)
        // AFTER lighting, so the legend colour is what you see and a shadow cannot wash it out.
        // The border is a couple of pixels of the tile's own 0..1 uv, so it stays a line at every
        // zoom instead of a band that grows with the tile.
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
if (uLodOn > 0.5) {
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uLodTint, 0.62);
  vec2 lodEdge = min(vLodUv, 1.0 - vLodUv);
  float lodFw = fwidth(vLodUv.x) + fwidth(vLodUv.y);
  float lodBorder = 1.0 - smoothstep(lodFw * 0.5, lodFw * 2.4, min(lodEdge.x, lodEdge.y));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.02), clamp(lodBorder, 0.0, 1.0));
}`)
      injectShade(shader)
    }
    m.customProgramCacheKey = () => 'corridor-terrain-lod'
    /*
     * THE TERRAIN'S CLIP BAND IS MILLIMETRES, NOT EIGHTY METRES. The road cover exists to hide the
     * sliver of ground that the road mesh is standing on, so the terrain gives up a thin shell at
     * the pavement and no more. The wide default is for a tree over a lane (which should not be
     * there at all); applied to the ground it deleted every hill standing over a road, and over an
     * underpass it deleted the land the road runs through — the fine DEM went, the coarse overview
     * showed from underneath, and the world was see-through (Rich, 2026-10-06).
     */
    installRoadClip(m, 2.5)
    return m
  }
  const roadCover = renderer ? new RoadCover(renderer) : null
  const terrainMat = terrainMaterial(imagery)
  const terrainMats: THREE.MeshStandardMaterial[] = [terrainMat]
  const terrainGeos: THREE.BufferGeometry[] = [terrainGeo]
  const overview = new THREE.Mesh(terrainGeo, terrainMat)
  overview.name = 'terrain'
  const terrain = overview
  group.add(terrain)

  // --- fine terrain, one mesh per tile ---------------------------------------------------------
  let stream: ImageryStream | null = null
  if (tileSet && L.tiles) {
    // Each tile is its own raster with its own lattice, so `gridGeometry` places it correctly and
    // hands it 0..1 UVs — exactly the UV a per-tile texture wants — with no changes at all. One
    // stride for every tile: two neighbouring terrain meshes at different strides do not share
    // their edge vertices and you get a lit crack between them at every boundary.
    const tileStride = strideFor(tileSet.tiles[0].dem.layer, lite ? 4_000 : 14_000)
    stream = new ImageryStream(base, L.tiles, renderer)
    // The per-tile vegetation mask from the same tiles' photos. It is no longer a gate on the grass
    // (the ground texture decides now — see the note at the `veg` declaration); the tiles still
    // land through here and invalidate the local grass, so the stream is kept.
    veg = new VegCover(tileSet.tiles, (t) => `${DATA_BASE}${base}${L.tiles!.dir}/${t.x}_${t.y}.${L.tiles!.texture ?? 'naip.jpg'}`, (t) => {
      const [x0, y0, x1, y1] = t.bounds
      grassRef?.invalidateWithin(x0, -y1, x1, -y0)
    })
    const grp = new THREE.Group()
    grp.name = 'terrain:tiles'
    // Until its own imagery streams in, a tile wears the site's NAIP overview — THROUGH A SECOND
    // UV SET that maps the tile's vertices into the overview raster. It used to be handed the
    // overview with the tile's own 0..1 UVs, which drew the whole site's photograph, black
    // corners and all, squashed into every 1 km tile beyond the 2 km imagery ring. From 5 km up
    // that is a grid of dark wedges on every tile edge: Rich's "big blue water seams between
    // tiles" (2026-09-26), isolated by hiding the imagery (the terrain under it was seamless) and
    // by counting resident textures on his GPU (8 of 59 had their own). The overview's texture is
    // cloned per tile so each clone can read channel 1; a clone shares its Source, so the GPU
    // holds the image once.
    const ovRF = anchor && L.naip?.geo ? new RasterFrame({ size: L.naip.size, geo: L.naip.geo }, anchor) : null
    const ovBbox = L.naip?.bbox
    // Where the overview has no data — the tile grid is the hull snapped to 1 km and the overview
    // is the fetched bbox, so crofton-triangle's outer ring of tiles runs 100-850 m past it — the
    // vertex gets a SENTINEL uv (-1) and the shader paints the bare tone there instead of
    // clamping to the overview's last row and smearing it across the rim. `toGrid` clamps, so it
    // cannot say "outside"; `contains` can.
    const OUT: [number, number] = [-1, -1]
    const overviewUv = ovRF
      ? (x: number, y: number): [number, number] => { if (!ovRF.contains(x, y)) return OUT; const g = ovRF.toGrid(x, y); return [g[0], g[1]] }
      : ovBbox
        ? (x: number, y: number): [number, number] => (x < ovBbox[0] || x > ovBbox[2] || y < ovBbox[1] || y > ovBbox[3] ? OUT : [(x - ovBbox[0]) / (ovBbox[2] - ovBbox[0]), (ovBbox[3] - y) / (ovBbox[3] - ovBbox[1])])
        : undefined
    for (const t of tileSet.tiles) {
      const geo = gridGeometry(t.dem, tileStride, () => 0, undefined, overviewUv)
      let placeholder: THREE.Texture | null = null
      if (imagery && overviewUv) {
        placeholder = imagery.clone()
        placeholder.channel = 1
      }
      const mat = terrainMaterial(placeholder)
      // what this tile wears when it has nothing of its own; the imagery toggle restores THIS,
      // never the raw overview (which reads channel 0 and is the squashed-site picture again)
      mat.userData.placeholder = placeholder
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = `terrain:${t.x}_${t.y}`
      grp.add(mesh)
      terrainMats.push(mat)
      terrainGeos.push(geo)
      stream.add(t, mat, placeholder)
    }
    group.add(grp)
    // The overview is still under the tiles, and two surfaces of the same ground at 8 m and 2 m
    // z-fight wherever the coarse one pokes through the fine one. Cut it to the tiles' coverage,
    // the same way the horizon is cut to the near DEM's.
    cutHorizon(terrainGeo, L.dem.bbox, L.dem.res * stride, heightAt, tileSet.covers)
  }

  // --- fine terrain, streamed: the LOD pyramid ------------------------------------------------
  let pyr: PyramidStream | null = null
  if (pyrSet && L.pyramid && anchor) {
    const grp = new THREE.Group()
    // Named terrain so the sun's shadow lands on the tiles once the overview mesh is hidden.
    grp.name = 'terrain'
    group.add(grp)
    pyr = new PyramidStream({
      base,
      index: L.pyramid,
      anchor,
      set: pyrSet,
      group: grp,
      // gridGeometry already reads a tile's own RasterFrame and emits 0..1 UVs, so a quadtree tile
      // places and textures with no changes — the same property that made the flat tiles work.
      // The decode worker now builds that grid, so most tiles arrive ready to wrap; the main-thread
      // `gridGeometry` is kept as the fallback for a worker-less decode.
      geometryFor: (t) => (t.grid ? geometryFromGrid(t.grid) : gridGeometry(t.dem, strideFor(t.dem.layer, lite ? 4_000 : 14_000), () => 0)),
      materialFor: (t) => {
        // Bare until the tile's own photo arrives. The overview's UVs are the whole site, so
        // painting it onto a quadtree tile stretches one picture across every tile.
        //
        // The base turf is allowed only on the TOP level. Every coarser level is backing store that
        // `seat()` drops under a resident child; turf there is grass at a seam nobody should see.
        const m = terrainMaterial(null, t.z === L.pyramid!.zmax)
        // Finer levels are biased further forward. A partial quad keeps its parent to cover the
        // empty quadrants, and the child has to win the depth test on the ground they share.
        const bias = 1 + t.z - L.pyramid!.zmin
        m.polygonOffset = true
        m.polygonOffsetFactor = -bias
        m.polygonOffsetUnits = -bias
        return m
      },
      textureFor: (t) => (t.hasNaip ? `${DATA_BASE}${base}${L.pyramid!.dir}/${t.z}/${t.x}_${t.y}.jpg` : null),
      fovY: (60 * Math.PI) / 180,
      viewportH: renderer?.domElement.height ?? 1080,
      budgetBytes: lite ? 96 * 1024 * 1024 : 256 * 1024 * 1024,
      maxVerts: lite ? 4_000 : 14_000,
    })
    // Prime under the car, not the ENU origin. Trailworks holds the stream on the foreground
    // until the ground under the view resolves; the origin of a geodesic frame is not the spawn.
    const spine = manifest.spine?.coords
    const mid = spine && spine.length ? spine[Math.floor(spine.length / 2)]! : null
    // The first tiles are the ones under the start. Priming at the middle of the spine fetched a
    // second high-detail neighbourhood and held both — 56 leaf tiles, 253 MB — before the car had
    // moved. The start is the level's point (`opts.focus`), else the bake's photo station; the
    // earlier fix fell back to the midpoint, which is what it always got on a world with no
    // points.json (crofton), so the fix never actually ran.
    const photoCoord = (): [number, number] | null => {
      const s = manifest.spine.photo_s
      if (!spine?.length || s == null) return null
      const i = Math.max(0, Math.min(spine.length - 1, Math.round((s / (manifest.spine.length_m || 1)) * (spine.length - 1))))
      return [spine[i]![0], spine[i]![1]]
    }
    const prime: [number, number] = opts.focus ? [opts.focus.x, -opts.focus.z] : photoCoord() ?? (mid ? [mid[0], mid[1]] : [0, 0])
    pyr.update(prime[0], prime[1], true)
  }

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
    overviewCanopy = sampler(chm)
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
    // On a tiled network the near ground is the tiles, not the whole DEM bbox — the overview
    // between them is itself only a coarse stand-in, and cutting the hull whole would leave the
    // horizon missing everywhere the bake did not reach.
    cutHorizon(geo, L.dem.bbox, hz.layer.res * hs, heightAt, tileSet ? tileSet.covers : undefined)
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
  // A centripetal Catmull-Rom is the road the short worlds were tuned on. Past a few thousand
  // nodes its arc-length table is the hitch, so a long spine (STREAM_LOCAL) is the polyline the
  // bake already densified. STREAM_LOCAL = 0 always takes the curve, however long the road is.
  const longSpine = T.STREAM_LOCAL > 0 && raw.length > 6000
  let curveLen: number
  let spineAt: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }
  let sp: THREE.Vector3[]
  if (longSpine) {
    const cum = new Float64Array(raw.length)
    for (let i = 1; i < raw.length; i++) cum[i] = cum[i - 1]! + raw[i].distanceTo(raw[i - 1])
    curveLen = cum[cum.length - 1] || 0
    spineAt = (s: number) => {
      const t = Math.min(curveLen, Math.max(0, s))
      if (raw.length < 2) return { pos: raw[0].clone(), dir: new THREE.Vector3(1, 0, 0) }
      let lo = 1, hi = cum.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cum[mid]! < t) lo = mid + 1
        else hi = mid
      }
      const span = cum[lo]! - cum[lo - 1]! || 1
      const f = Math.min(1, Math.max(0, (t - cum[lo - 1]!) / span))
      const pos = raw[lo - 1].clone().lerp(raw[lo], f)
      const dir = raw[lo].clone().sub(raw[lo - 1])
      if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0)
      else dir.normalize()
      return { pos, dir }
    }
    const n = Math.min(4000, Math.max(2, Math.round(curveLen / 50)))
    sp = []
    for (let i = 0; i <= n; i++) sp.push(spineAt((curveLen * i) / n).pos)
  } else {
    const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal')
    curve.arcLengthDivisions = Math.max(200, raw.length * 8)
    curveLen = curve.getLength()
    const ribbonN = T.STREAM_LOCAL > 0 ? Math.min(4000, Math.max(2, Math.round(curveLen / 6))) : Math.max(2, Math.round(curveLen / 6))
    sp = curve.getSpacedPoints(ribbonN)
    spineAt = (s: number) => {
      const u = Math.min(1, Math.max(0, s / curveLen))
      const pos = curve.getPointAt(u)
      const dir = curve.getTangentAt(u)
      return { pos, dir }
    }
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
  /** a kerbed street (residential, tertiary…) has a gutter, no shoulder and no edge line — see props.KERBED */
  const kerbedAt = (s: number) => isKerbed(segAt(s)?.tags?.highway)
  const pavedHalfAt = (s: number) => pavedWidth(lanesAt(s), twoWayAt(s), kerbedAt(s)) / 2
  // How far right of the spine the asphalt's centre sits: 0 on a two-way road, half the shoulder
  // difference on a carriageway, because OSM draws a motorway down its travel lanes and not down
  // the middle of its asphalt. edgeDistance has to use this or the pavement the car and the grass
  // believe in drifts 0.9 m from the one the asphalt mesh draws — the same class of disagreement
  // the two-way width fix removed.
  const pavedOffsetAt = (s: number) => pavedOffset(twoWayAt(s), kerbedAt(s))
  const road = new THREE.Group()
  road.name = 'road'
  /**
   * Concrete for the bridges carried by streamed branch ways (the crossing carriageway over an
   * underpass). Filled by `addBranchBridge` as branch roads build; parented under `structures` at
   * assembly so the layer toggle reaches it. Declared here, at function scope, because the branch
   * builders live in a nested block. Rich, 2026-10-06.
   */
  const branchBridges = new THREE.Group()
  branchBridges.name = 'branchBridges'
  /** Set once `addDriveways` is defined inside the road block below; the tile pump calls it per
   *  cell to lay a streamed world's driveways as its tiles arrive (the load path lays them all). */
  let addDrivewaysBatch: (driveways: NonNullable<Manifest['driveways']>, stubs: NonNullable<Manifest['stubs']>) => void = () => {}
  /** Set at the branch-segment grid below; a streamed branch adds its segments as its tile arrives,
   *  so the crosswalk pass finds the nearest road direction near a crossing node. */
  let indexBranchSegment: (br: NonNullable<Manifest['branches']>[number]) => void = () => {}
  const tSurfaceSets = performance.now()
  surfaceSets ??= await loadSurfaceSets()
  bootDetail.push({ phase: 'paving: surface sets (textures)', ms: Math.round(performance.now() - tSurfaceSets) })
  /*
   * THE WORLD'S OWN TEXTURES (surfacesdoc.ts): which library material draws each road class and
   * the grasses, and the pools its buildings are drawn from. `roadSets` is what the road and the
   * strips read; it is the defaults with the world's choices laid over, and `setSurfaces` swaps
   * it and rebuilds the road when the World tab saves.
   */
  const tSurfDoc = performance.now()
  let surfacesDoc: SurfacesDoc = await loadSurfacesDoc(manifest.slug)
  bootDetail.push({ phase: 'paving: surfaces doc', ms: Math.round(performance.now() - tSurfDoc) })
  let roadSets = resolveSurfaceSets(surfaceSets, surfacesDoc)
  applyTerrainFallback(roadSets)
  const poolOf = (doc: SurfacesDoc): TexturePool | null => {
    const b = doc.buildings
    if (!b || (!b.walls?.length && !b.roofs?.length)) return null
    const entry = (id: string) => ({ id, url: `/assetsvc/materials/${encodeURIComponent(id)}/file/albedo.jpg`, mpt: surfaceSets?.[id]?.metresPerTile ?? 2 })
    return { walls: (b.walls ?? []).map(entry), roofs: (b.roofs ?? []).map(entry), seed: b.seed ?? 1 }
  }
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
    const cls = surf.class[i]
    // `unknown` is the classifier saying it could not label this piece, not a surface. Used as a
    // class it resolved to no surface set and fell to a flat #444446 — crofton is 113/449 pieces
    // (2.3 km of trunk, including the whole home stretch), so the road lost its asphalt texture
    // exactly where the car spawns. Draw it as the default asphalt instead.
    return !cls || cls === 'unknown' ? 'asphalt_aged' : cls
  }
  // A continent is one mesh if the whole spine is stations() here. The streamed path draws a
  // kilometre of asphalt around where this visit starts — the level's point, not the photo
  // station — and gradeNear slides that window. The editor's whole-site preview, and
  // STREAM_LOCAL = 0, still build the one mesh they always did.
  const local = T.STREAM_LOCAL > 0 && !opts.plantWhole
  const HOME_M = 1000
  const windowedSpine = local
  const SPINE_WIN = HOME_M
  const photoS = Math.min(curveLen, Math.max(0, manifest.spine.photo_s ?? curveLen / 2))
  // A LOCAL BUILD MUST HAVE A CENTRE. Without one (`opts.focus` is fed from `?level=`'s start point,
  // else the world's home in points.json) every `local && opts.focus` guard below silently no-ops:
  // `inDisc` returns true for everything and the whole site builds at load — on crofton that is 2 s
  // of sidewalks, 0.5 s of parking and 6.5 s of crop rows for a county the car is not in. The bake's
  // photo station is the fallback because `homeS` already centres the windowed spine on it; using
  // anything else would draw the road around one point and the fields around another.
  const focus = opts.focus ?? (local ? { x: spineAt(photoS).pos.x, z: spineAt(photoS).pos.z } : undefined)
  let homeS = photoS
  if (local && focus) {
    let best = Infinity
    const pick = (s: number) => {
      const p = spineAt(s).pos
      const d = (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2
      if (d < best) { best = d; homeS = s }
    }
    for (let s = 0; s <= curveLen; s += 40) pick(s)
    const a = Math.max(0, homeS - 40)
    const b = Math.min(curveLen, homeS + 40)
    for (let s = a; s <= b; s += 5) pick(s)
  }
  let spineLo = 0
  let spineHi = manifest.spine.length_m
  if (windowedSpine) {
    spineLo = Math.max(0, homeS - SPINE_WIN)
    spineHi = Math.min(curveLen, homeS + SPINE_WIN)
  }
  const spanStations = (s0: number, s1: number) => {
    const st: { pos: THREE.Vector3; dir: THREE.Vector3; s: number }[] = []
    // Snap the window to the global 6 m station grid. roadMesh decides a lane dash from the
    // ABSOLUTE station (`s mod 12 < 3`), so a window that starts at an arbitrary arc length
    // (homeS − 1000) shifts the phase. If that phase lands in [3, 9) neither of the two 6 m
    // stations in a 12 m cycle satisfies the test and THE WINDOW PAINTS NO LANE DASHES AT ALL —
    // crofton's home window (s0 ≈ 1685.4) did exactly this and the northbound lanes lost every
    // divider. Branch and sibling roads start at s=0, so they never showed it.
    for (let s = Math.floor(s0 / 6) * 6; s <= s1; s += 6) {
      const p = spineAt(s)
      const dir = p.dir.clone().setY(0)
      if (dir.lengthSq() > 1e-8) dir.normalize()
      st.push({ pos: p.pos, dir, s })
    }
    return st
  }
  let mainSt = windowedSpine ? spanStations(spineLo, spineHi) : stations(spineAt, manifest.spine.length_m, 6)
  let pavedS = windowedSpine ? homeS : 0
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
        pushJ(w.x, w.z, Math.max(T.JUNCTION_CLEAR, (branchLanes(br.lanes) * T.LANE_WIDTH) / 2 + T.JUNCTION_CLEAR * 0.4))
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
  /**
   * Is this marking inside a junction? Asked per marking quad, at that line's own lateral offset.
   * With the bake's junction model the cut is per ARM, at that arm's stop line
   * (`junctionPaintCut`); the circles above are the fallback for a bake without one.
   */
  const sectorCut = manifest.intersections && ((manifest.intersections.paint?.length ?? 0) || manifest.intersections.list?.length) ? junctionPaintCut(manifest) : null
  const paintGrid = new Map<string, { x: number; z: number; r: number }[]>()
  let paintReach = 1
  if (T.STREAM_LOCAL > 0 && junctions.length > 64) {
    const cell = 200
    for (const j of junctions) {
      paintReach = Math.max(paintReach, Math.ceil(j.r / cell))
      const k = `${Math.floor(j.x / cell)},${Math.floor(j.z / cell)}`
      const arr = paintGrid.get(k)
      if (arr) arr.push(j)
      else paintGrid.set(k, [j])
    }
  }
  const paintOff = (x: number, z: number) => {
    if (sectorCut) return sectorCut(x, z)
    if (paintGrid.size) {
      const cell = 200
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell)
      for (let a = -paintReach; a <= paintReach; a++) for (let b = -paintReach; b <= paintReach; b++) {
        const arr = paintGrid.get(`${cx + a},${cz + b}`)
        if (!arr) continue
        for (const j of arr) if ((j.x - x) ** 2 + (j.z - z) ** 2 < j.r * j.r) return true
      }
      return false
    }
    for (const j of junctions) if ((j.x - x) ** 2 + (j.z - z) ** 2 < j.r * j.r) return true
    return false
  }

  // the asphalt and paint are rebuilt when a road knob moves (F6 → road), so keep the builders
  /*
   * WHERE THE BAKED ROAD IS NOT DRAWN, by station along the spine.
   *
   * A stunt fixture replaces a stretch of road rather than sitting on it (src/stunts.ts), so the
   * two must not both exist. Mutable and re-read on every build, because fixtures are placed and
   * dragged in the editor and the road has to follow without a reload.
   */
  let roadSkip: ((chain: number, s: number) => boolean) | null = null
  // a builder takes the skip it should apply, so the same one makes the base road and the holed one
  type RoadSkip = ((chain: number, s: number) => boolean) | null
  const roadBuilders: ((skip: RoadSkip) => THREE.Object3D)[] = [
    (skip) => roadMesh(mainSt, lanesAt, classAt, roadSets, 0.02, twoWayAt, paintOff, kerbedAt, skip ? (s: number) => skip(0, s) : null),
  ]
  let roadParts: THREE.Object3D[] = []
  /*
   * THE BAKED ROAD IS A LAYER, AND A STUNT IS ANOTHER LAYER OVER IT.
   *
   * Rich, 2026-09-29: *"would require all of these fixtures to be layers on top of the map instead
   * of baked into it, the underlying OSM data should exist and the stunts modify on top of the base
   * data"*. He is right, and the first cut of this was wrong: `setRoadSkip` REBUILT the road with a
   * hole in it, which makes a fixture's presence a property of the OSM geometry. A program that
   * hides a loop at runtime would then have to rebuild the road to get its tarmac back, and the
   * base data would only exist in whatever state the last fixture left it.
   *
   * So the whole road is built once and KEPT. When something asks for holes, a second version is
   * built with them and the whole one is hidden — both are in the graph, the base is never
   * destroyed, and clearing the skip is a visibility flip and a dispose rather than a rebuild.
   */
  let roadBase: THREE.Object3D[] = []
  let roadHoled: THREE.Object3D[] = []
  const forget = (o: THREE.Object3D) => {
    road.remove(o)
    disposeDeep(o)
    const i = roadParts.indexOf(o)
    if (i >= 0) roadParts.splice(i, 1)
  }
  /**
   * `rebuildBase` throws the base away and builds it again — for a change of road WIDTH, which
   * changes the geometry rather than what is hidden.
   */
  /*
   * THE BRANCHES GET THEIR HOLES TOO. A branch's road is built lazily, one chunk at a time, as the
   * eye reaches it — so the fixture placed on Patuxent River Road (Rich, 2026-09-30, with the road
   * still drawn through his loop) has to hole a mesh that may not exist yet, and one that already
   * does. `holeBranches` is filled in where the branches are built, below, and is called from
   * `buildRoads` whenever the skip changes and from the lazy builder whenever a branch appears.
   */
  let holeBranches = () => {}
  const buildRoads = (rebuildBase = false) => {
    if (rebuildBase) {
      for (const o of roadBase) forget(o)
      roadBase = []
    }
    if (!roadBase.length) {
      roadBase = roadBuilders.map((b) => b(null))
      for (const o of roadBase) { road.add(o); roadParts.push(o) }
    }
    for (const o of roadHoled) forget(o)
    roadHoled = []
    if (!roadSkip) {
      for (const o of roadBase) o.visible = true
      holeBranches()
      return
    }
    roadHoled = roadBuilders.map((b) => b(roadSkip))
    for (const o of roadHoled) { road.add(o); roadParts.push(o) }
    holeBranches()
    /*
     * ONLY THE BASE BUILDERS' OWN OUTPUT IS HIDDEN.
     *
     * `roadParts` is everything in the road group that has to be disposed with the site — and the
     * BRANCH roads are appended to it lazily, one per chunk, as the eye reaches them. The first
     * version of this hid all of `roadParts`, so putting a stunt anywhere made every secondary road
     * in the world disappear while only the spine came back in its holed form (Rich, 2026-09-29:
     * "placing stunts on secondary roads makes the secondary roads no longer render, just the stunt
     * is there").
     */
    for (const o of roadBase) o.visible = false
  }
  // spine stations every 5 m, for "what is the road doing next to this point" lookups.
  // A long spine keeps the same answer from a 200 m grid plus a local refine, instead of one
  // station per 5 m for the whole continent. Short spines, and STREAM_LOCAL = 0, keep the array.
  const nearestSpine = ((): ((x: number, z: number) => { x: number; z: number; y: number; s: number; dist: number }) => {
    if (!(T.STREAM_LOCAL > 0 && curveLen > 20000)) {
      const spineSt: { x: number; z: number; y: number; s: number }[] = []
      for (let s = 0; s <= curveLen; s += 5) {
        const p = spineAt(s).pos
        spineSt.push({ x: p.x, z: p.z, y: p.y, s })
      }
      return (x, z) => {
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
    }
    const cell = 200
    const grid = new Map<string, { x: number; z: number; y: number; s: number }[]>()
    for (let s = 0; s <= curveLen; s += 50) {
      const p = spineAt(s).pos
      const rec = { x: p.x, z: p.z, y: p.y, s }
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.z / cell)}`
      const arr = grid.get(k)
      if (arr) arr.push(rec)
      else grid.set(k, [rec])
    }
    return (x, z) => {
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell)
      let best = Infinity
      let hit = { x, z, y: 0, s: 0 }
      const scan = (n: number) => {
        for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
          const arr = grid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            const d = (p.x - x) ** 2 + (p.z - z) ** 2
            if (d < best) { best = d; hit = p }
          }
        }
      }
      scan(1)
      if (best === Infinity) scan(4)
      const s0 = Math.max(0, hit.s - 50), s1 = Math.min(curveLen, hit.s + 50)
      for (let s = s0; s <= s1; s += 5) {
        const p = spineAt(s).pos
        const d = (p.x - x) ** 2 + (p.z - z) ** 2
        if (d < best) { best = d; hit = { x: p.x, z: p.z, y: p.y, s } }
      }
      return { ...hit, dist: Math.sqrt(best === Infinity ? 0 : best) }
    }
  })()
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
    if (!(len2 > 1)) continue // a sibling whose points coincide (see the branch guard below)
    const sibAt = (s: number) => {
      const u = Math.min(1, Math.max(0, s / len2))
      return { pos: c2.getPointAt(u), dir: c2.getTangentAt(u) }
    }
    sibAts.push({ at: sibAt, len: len2, spineS: (s: number) => { const p = sibAt(s).pos; return nearestSpine(p.x, p.z).s } })
    roadBuilders.push(() => roadMesh(stations(sibAt, len2, 6), () => 2, () => 'asphalt_aged', roadSets, 0.02, () => false, paintOff))
  }
  mark('paving: spine mesh setup + siblings')
  // --- network branches: every other road of a network site is a first-class carriageway --------
  // Its grade is its own lidar profile (the bake densified it like the spine), its lanes and
  // direction its own OSM tags; it gets stations in the edge grid (so grass, trees and the car
  // know it is pavement), an asphalt+paint mesh, and below, its own strip. Kept apart from the
  // divided-highway siblings: those share the spine's grade and widen the spine's strip.
  // `road` builds the branch's asphalt and paint; it runs inside the branch's lazy unit, with its strip
  // one per branchAts entry, same order: the raw graded points and a way to rebuild the curve after they move
  const branchRaw: { br: NonNullable<Manifest['branches']>[number]; rawB: THREE.Vector3[]; dirty: boolean; recurve: () => void }[] = []
  const branchAts: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number; half: number; name: string; ref: string | null; lanes: number; twoWay: boolean; highway: string | null; road: (skip?: ((s: number) => boolean) | null) => THREE.Group; bounds: [number, number, number, number] }[] = []
  const laterBranches: NonNullable<Manifest['branches']>[number][] = []
  // Roads whose box sits inside a kilometre of the start, plus the roads that meet them, are
  // built now so the junction grade is settled before any asphalt exists. The rest wait for the
  // car. STREAM_LOCAL = 0, and the editor preview, take every branch here.
  const homePt = local && focus ? new THREE.Vector3(focus.x, spineAt(homeS).pos.y, focus.z) : spineAt(homeS).pos
  // Land use streams in with the tiles. The rings feed a growing point-in-polygon index (zoning.ts)
  // for the grass and an incremental crop-field builder; the index is seeded from whatever is
  // resident (nothing on a tiled world). `addLanduseCell` is assigned by the crop block below and
  // consumed by `hydrateCell`, which is why both live in the function scope rather than the block.
  const luIndex = landuseZone(manifest)
  let addLanduseCell: ((list: NonNullable<Manifest['landuse']>, key: string) => void) | null = null
  const branchTouches = (coords: [number, number, number?][], px: number, pz: number, rad: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of coords) {
      if (p[0] < x0) x0 = p[0]
      if (p[0] > x1) x1 = p[0]
      if (p[1] < y0) y0 = p[1]
      if (p[1] > y1) y1 = p[1]
    }
    const z0 = -y1, z1 = -y0
    const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0
    const dz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0
    return dx * dx + dz * dz <= rad * rad
  }
  const takeNow = new Set<NonNullable<Manifest['branches']>[number]>()
  if (local) {
    const all = manifest.branches ?? []
    for (const br of all) if (br.coords && br.coords.length >= 2 && branchTouches(br.coords, homePt.x, homePt.z, HOME_M)) takeNow.add(br)
    const byRoad = new Map<string, NonNullable<Manifest['branches']>[number]>()
    for (const br of all) if (br.id) byRoad.set(br.id, br)
    const extra: NonNullable<Manifest['branches']>[number][] = []
    for (const br of takeNow) for (const j of br.junctions ?? []) for (const other of j.with ?? []) {
      const o = byRoad.get(other)
      if (o) extra.push(o)
    }
    for (const o of extra) takeNow.add(o)
  }
  const takenBranchKeys = new Set<string>()
  const takeBranch = (br: NonNullable<Manifest['branches']>[number]): boolean => {
    if (!br.coords || br.coords.length < 2) return false
    /*
     * A WAY IS NOW WRITTEN INTO EVERY TILE IT CROSSES, so the same branch arrives again with the
     * next tile along its length. Without this the road would be built twice — two meshes, two
     * splines, two sets of stations — everywhere two of its tiles are loaded together. Dedupe by
     * the bake's `id`, falling back to a coordinate fingerprint for an un-id'd branch.
     */
    const c0 = br.coords[0]
    const key = br.id ?? `${c0[0]},${c0[1]},${br.coords.length},${br.name ?? ''}`
    if (takenBranchKeys.has(key)) return false
    takenBranchKeys.add(key)
    const rawB = br.coords.map(([x, y, z]) => toWorld(x, y, (Number.isFinite(z) ? z : heightAt(x, y)) + 0.4))
    let cB = new THREE.CatmullRomCurve3(rawB, false, 'centripetal')
    cB.arcLengthDivisions = Math.max(100, rawB.length * 8)
    let lenB = cB.getLength()
    // A branch whose points all coincide has no length, and s / 0 is NaN: getPointAt(NaN) reads
    // an undefined point and the WHOLE site fails to load ("corridor: load failed ... reading
    // 'x'"). A re-vector on 2026-09-26 produced one such branch on crofton-triangle and took the
    // viewer down for everyone until this guard. A road shorter than a metre is not a road.
    if (!(lenB > 1)) {
      console.warn(`${manifest.slug}: branch ${(br as { id?: string }).id ?? br.name ?? '?'} has ${rawB.length} points and ${lenB.toFixed(2)} m of length — skipped`)
      return false
    }
    const atB = (s: number) => {
      const u = Math.min(1, Math.max(0, s / lenB))
      return { pos: cB.getPointAt(u), dir: cB.getTangentAt(u) }
    }
    const lanesB = branchLanes(br.lanes)
    const twoWayB = br.oneway === 'yes' || br.oneway === '-1' ? false : br.oneway === 'no' ? true : !['motorway', 'motorway_link', 'trunk_link', 'primary_link'].includes(br.highway ?? '')
    const kerbedB = isKerbed(br.highway)
    const halfB = pavedWidth(lanesB, twoWayB, kerbedB) / 2
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity
    for (const q of rawB) { if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x; if (q.z < bz0) bz0 = q.z; if (q.z > bz1) bz1 = q.z }
    /*
     * `bi` IS CAPTURED HERE, not read inside the closure.
     *
     * It used to say `branchAts[branchRaw.length - 1].len = lenB`, and `branchRaw.length` is read
     * when `recurve` RUNS, not when it is pushed — by then it is 427. So every junction-warped
     * branch wrote its own new length into the LAST branch's entry. On crofton-triangle the last
     * branch is Riedel Road, 2,515 m of tertiary that is superior at all thirteen of its
     * junctions, so it never recurves and never repaired itself: it ended up carrying the length
     * of Hawk Hollow Drive, 271 m.
     *
     * `addStations` bounds its loop with that length, so 2,235 m of Riedel Road had asphalt drawn
     * full length (the mesh uses the closure's own `lenB`, which was right) and NO DISTANCE FIELD
     * AT ALL. Grass, trees, the verge, the car's on-road test and the road-name readout were all
     * blind to it — the field answered "+57 m to the nearest road" while you stood on it, which
     * is how grass came to be growing through the asphalt there (Rich, 2026-09-27).
     */
    const bi = branchAts.length
    branchRaw.push({ br, rawB, dirty: false, recurve: () => { cB = new THREE.CatmullRomCurve3(rawB, false, 'centripetal'); cB.arcLengthDivisions = Math.max(100, rawB.length * 8); lenB = cB.getLength(); branchAts[bi].len = lenB } })
    branchAts.push({ at: atB, len: lenB, half: halfB, name: br.name ?? br.ref ?? 'branch', ref: br.ref ?? null, lanes: lanesB, twoWay: twoWayB, highway: br.highway ?? null, bounds: [bx0, bz0, bx1, bz1], road: (skip = null) => roadMesh(stations(atB, lenB, 6), () => lanesB, () => 'asphalt_aged', roadSets, 0.02, () => twoWayB, paintOff, () => kerbedB, skip) })
    return true
  }
  const branchTiles = manifest.vt?.branch ?? []
  const branchTiled = !!(manifest.vt?.cells?.length && branchTiles.length && manifest.vt.dir)
  const branchSize = manifest.vt?.size_m || 1000
  // A tiled world streams its branch network with its vector tiles: the home tiles are taken now,
  // so the junction grade is settled before any asphalt is built, and the rest arrive through the
  // pump and meet as they come (the `branch-cell` units listed at the end of the paving block). An
  // untiled world still has every branch resident.
  const inHomeBranchCell = (t: { x: number; y: number }) => !!focus
    && t.x >= Math.floor((focus.x - HOME_M) / branchSize) && t.x <= Math.floor((focus.x + HOME_M) / branchSize)
    && t.y >= Math.floor((-focus.z - HOME_M) / branchSize) && t.y <= Math.floor((-focus.z + HOME_M) / branchSize)
  if (branchTiled) {
    for (const t of branchTiles) {
      if (!inHomeBranchCell(t)) continue
      const files = await loadVectorTile(manifest.slug, manifest.vt!.dir, t.x, t.y)
      relieveCell(files)
      for (const br of (files.branches ?? []) as NonNullable<Manifest['branches']>) takeBranch(br)
    }
  } else {
    for (const br of manifest.branches ?? []) {
      if (!br.coords || br.coords.length < 2) continue
      if (local && chm && !takeNow.has(br)) { laterBranches.push(br); continue }
      takeBranch(br)
    }
  }
  mark('paving: branch curves')
  // --- ROADS MEET AT THE SAME HEIGHT ---------------------------------------------------------
  // Every road carries its own lidar grade, and two profiles measured independently do not agree
  // where the roads meet: Saint Stephens Church Road reached Chesterfield Road 1.3–1.9 m above it
  // (crownsville, measured in probes/corridor-crosssection.mjs), a cliff across the junction with
  // the DEM saying the ground was Chesterfield's height. The bake owns the profiles; the viewer
  // owns the promise that a junction is one surface. So at every junction the INFERIOR road is
  // re-graded to meet the superior one — the bake's own `superior` approach flag, else the spine
  // if the node sits on it, else the better road class (the longer road on a tie) — with the
  // correction fading out over JUNCTION_MEET_M along the inferior road. The superior road, and
  // the spine always, keep their grade.
  const junctionMeet = { junctions: 0, warped: 0, maxStep: 0, noTarget: 0 }
  // Where the junction meet's wall time goes. `sync` re-meets the whole network once per arriving
  // branch tile, and at 200 mph those tiles arrive faster than one pump unit at a time can drain
  // them — a probe reads this to see whether the meet, not the asphalt, is the backlog.
  const meetStats = { calls: 0, branches: 0, lastMs: 0, worstMs: 0, totalMs: 0 }
  let finishJunctions: (budget?: Budget) => Promise<number[]> = async () => []
  // node -> junction, so a branch knows the priority facts at the node it meets. A tiled world adds
  // to it as intersection tiles arrive (hydrateCell), and `finishJunctions` re-runs the meet.
  const xByNode = new Map<number, NonNullable<Manifest['intersections']>['list'][number]>()
  {
    const RANK: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7, service: 8 }
    const rank = (hw?: string | null) => RANK[(hw ?? '').replace(/_link$/, '')] ?? 9
    const spineWays = new Set((manifest.spine.segments ?? []).map((g) => `r${(g as { osm_id?: number }).osm_id}`))
    const byId = new Map<string, number>()
    branchRaw.forEach((b, i) => { if (b.br.id) byId.set(b.br.id, i) })
    for (const x of manifest.intersections?.list ?? []) for (const n of x.nodes ?? []) xByNode.set(n, x)
    /** a road's graded height at the raw vertex nearest (x, z) — at a node, that vertex IS the node */
    const heightOf = (i: number, x: number, z: number) => {
      let best = Infinity, y = NaN
      for (const q of branchRaw[i].rawB) { const d = (q.x - x) ** 2 + (q.z - z) ** 2; if (d < best) { best = d; y = q.y } }
      return best < 6 * 6 ? y : NaN
    }
    const MEET = T.JUNCTION_MEET_M
    const metJunction = new Set<string>()
    const meetOne = (b: (typeof branchRaw)[number], i: number) => {
      for (const j of b.br.junctions ?? []) {
        const key = `${i}:${j.node ?? j.x},${j.y}`
        if (metJunction.has(key)) continue
        const w = toWorld(j.x, j.y, 0)
        const x = j.node != null ? xByNode.get(j.node) : undefined
        const mine = x?.approaches.find((a) => a.road === b.br.id)
        if (mine?.superior) { metJunction.add(key); continue }
        let target = NaN
        const sup = x?.approaches.find((a) => a.superior && a.road !== b.br.id)
        if (sup && spineWays.has(sup.road)) target = nearestSpine(w.x, w.z).y
        else if (sup && byId.has(sup.road)) target = heightOf(byId.get(sup.road)!, w.x, w.z)
        else {
          const ns = nearestSpine(w.x, w.z)
          if (ns.dist < 4) target = ns.y
          else {
            const myRank = rank(b.br.highway), myLen = b.br.length_m ?? 0
            for (const other of j.with ?? []) {
              const k = byId.get(other)
              if (k == null || k === i) continue
              const o = branchRaw[k].br
              const better = rank(o.highway) < myRank || (rank(o.highway) === myRank && (o.length_m ?? 0) > myLen)
              if (better) { target = heightOf(k, w.x, w.z); break }
            }
          }
        }
        if (!Number.isFinite(target)) { junctionMeet.noTarget++; continue }
        let vi = -1, best = Infinity
        b.rawB.forEach((q, k) => { const d = (q.x - w.x) ** 2 + (q.z - w.z) ** 2; if (d < best) { best = d; vi = k } })
        if (vi < 0 || best > 6 * 6) continue
        metJunction.add(key)
        const step = target - b.rawB[vi].y
        junctionMeet.junctions++
        if (Math.abs(step) < 0.05) continue
        junctionMeet.warped++
        if (Math.abs(step) > junctionMeet.maxStep) junctionMeet.maxStep = Math.abs(step)
        for (const dir of [-1, 1]) {
          let dist = 0
          for (let k = vi; k >= 0 && k < b.rawB.length; k += dir) {
            if (k !== vi) dist += Math.hypot(b.rawB[k].x - b.rawB[k - dir].x, b.rawB[k].z - b.rawB[k - dir].z)
            if (dist > MEET) break
            if (dir === 1 && k === vi) continue // the node itself is done on the -1 pass
            b.rawB[k].y += step * (1 - THREE.MathUtils.smoothstep(dist, 0, MEET))
          }
        }
        b.dirty = true
      }
    }
    const sync = async (budget?: Budget) => {
      const t0 = performance.now()
      const warped: number[] = []
      try {
        branchRaw.forEach((b, i) => { if (b.br.id) byId.set(b.br.id, i) })
        // This pass re-meets EVERY branch, and it runs once per arriving branch tile — so as the
        // network grows it is O(N) a call over data that mostly does not need it, and it sits in the
        // `loadVectorTile` continuation with no yield. On dc-metro a late call measured 2.97 s in
        // `gradeStats.worstMs` on a `branch-cell` unit — the same un-budgeted freeze as the street
        // furniture, one scope down. It still re-runs (an arriving intersection can give an unmet
        // junction a target at last), but it yields per branch, so the frame paints between.
        for (let i = 0; i < branchRaw.length; i++) { await budget?.tick(); meetOne(branchRaw[i], i) }
        for (let i = 0; i < branchRaw.length; i++) {
          const b = branchRaw[i]
          if (!b.dirty) continue
          await budget?.tick()
          b.recurve(); b.dirty = false; warped.push(i)
        }
      } finally {
        const dt = performance.now() - t0
        meetStats.calls++
        meetStats.branches = branchRaw.length
        meetStats.lastMs = dt
        meetStats.totalMs += dt
        if (dt > meetStats.worstMs) meetStats.worstMs = dt
      }
      return warped
    }
    finishJunctions = sync
    await sync()
    junctionMeet.maxStep = +junctionMeet.maxStep.toFixed(2)
  }
  mark('paving: junctions meet')
  buildRoads()
  mark('paving: primary road mesh')

  // --- trees, one per canopy cell, as tall as the lidar says ---------------------------------
  let trees: THREE.Group | undefined
  let treeCount = 0
  let updateNear: (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch?: number) => void = () => {}
  const nearPerf: NearPerf = { roadCover: 0, trees: 0, treesPlant: 0, treesPump: 0, treesPatch: 0, treesNear: 0, treesFar: 0, treesShadow: 0, grass: 0, other: 0, water: 0, stream: 0, pyr: 0, lod: 0, grade: 0, veg: 0, total: 0 }
  let retune: () => void = () => {}
  let applySurfaces: (doc: SurfacesDoc) => void = () => {}
  let setSeason: (season: Season) => void = () => {}
  let groundAtWorld: (x: number, z: number) => number | null = (x, z) => heightAt(x, -z)
  // --- LAZY GRADING: the strips, the terrain sink and the buildings are built around the eye ---
  // A unit is a chunk of the primary strip, one branch strip, or one 500 m cell of buildings.
  // `gradeNear` starts the nearest unfinished unit inside STREAM_BUILD_M. The unit's own fill
  // (vertices, the sink, a branch's asphalt) yields on the Budget it is handed, so one chunk
  // cannot own the frame. Nothing waits on them: the ground is a formula (gradedHeight below),
  // so the car, the grass and the furniture stand on the graded surface before its mesh exists.
  interface GradeUnit { key: string; x: number; z: number; r: number; done: boolean; run: (budget: Budget) => void | Promise<void> }
  const gradeUnits: GradeUnit[] = []
  const signalTicks: ((time: number) => void)[] = []
  if (windowedSpine) {
    gradeUnits.push({
      key: 'spine-window',
      x: homePt.x,
      z: homePt.z,
      r: 0,
      done: true,
      run: () => {
        mainSt = spanStations(spineLo, spineHi)
        buildRoads(true)
      },
    })
  }
  // worstMs is the longest unsliced stretch inside a unit — the hitch a frame can feel. A unit's
  // wall time is not a hitch: the fill yields every STREAM_BUDGET_MS.
  const gradeStats = { built: 0, strips: 0, buildings: 0, ms: 0, worstMs: 0, worst: '' }
  // the style's road paint, applied to a road mesh that arrives after the style was set
  let paintNow: { centre: THREE.Color; edge: THREE.Color } | null = null
  const gradeEye = new THREE.Vector3(NaN, NaN, NaN)
  let gradePumping = false
  let currentUnitKey = ''
  /**
   * How far a unit is from the eye for scheduling. The spine-window rebuild is positioned by
   * `pavedS`, not by the eye, and a fast drive slides `pavedS` forward faster than the pump
   * drains: the queued revamp is then left well behind the eye. Gating it on STREAM_BUILD_M (as
   * every branch and building unit is) left it unselected forever — `pavedS` had already moved,
   * so no further slide would fire either, and the spine's asphalt stayed a kilometre back with
   * the pump idle and nothing pending. Rich, 2026-10-07: the outer carriageway of the Capital
   * Beltway was grass where the car stood. One cheap unit, always in range once queued.
   */
  const unitDist = (u: GradeUnit) => u.key === 'spine-window' ? -Infinity : Math.hypot(u.x - gradeEye.x, u.z - gradeEye.z) - u.r
  /** the nearest unfinished unit inside STREAM_BUILD_M of the eye, or null */
  const nextUnit = (): GradeUnit | null => {
    let best: GradeUnit | null = null, bd = Infinity
    for (const u of gradeUnits) {
      if (u.done) continue
      const d = unitDist(u)
      if (d < bd) { bd = d; best = u }
    }
    return best && bd <= T.STREAM_BUILD_M ? best : null
  }
  const pendingNear = () => { let n = 0; for (const u of gradeUnits) if (!u.done && unitDist(u) <= T.STREAM_BUILD_M) n++; return n }
  // THE PUMP IS A MACROTASK LOOP, NOT A FRAME HOOK. Building on requestAnimationFrame would tie
  // the build to the frame rate (a slow frame, a hidden tab: no build — see reference-raf-budget-
  // deadlock), so the frame only tells the pump where the eye is. One unit runs at a time. Its
  // fill yields on the Budget (rAF, or a timer if no frame is coming). The first slice is a
  // setTimeout(0) so the frame that noticed the eye paints before any vertex is written. A hidden
  // tab does not yield: setTimeout there is about 1 Hz and the build would never finish.
  const pump = async () => {
    if (gradePumping) return
    gradePumping = true
    const visible = () => typeof document === 'undefined' || !document.hidden
    try {
      if (visible()) await new Promise<void>((r) => setTimeout(r, 0))
      for (;;) {
        const u = nextUnit()
        if (!u) return
        u.done = true
        const budget = new Budget(T.STREAM_BUDGET_MS)
        const u0 = performance.now()
        currentUnitKey = u.key
        try {
          await u.run(budget)
        } finally {
          currentUnitKey = ''
        }
        const slice = budget.finish().worstSliceMs
        gradeStats.built++
        gradeStats.ms += performance.now() - u0
        if (slice > gradeStats.worstMs) { gradeStats.worstMs = slice; gradeStats.worst = u.key }
        if (visible()) await new Promise<void>((r) => setTimeout(r, 0))
      }
    } finally {
      gradePumping = false
    }
  }
  const gradeNear = (eye: THREE.Vector3) => {
    gradeEye.copy(eye)
    if (windowedSpine) {
      const n = nearestSpine(eye.x, eye.z)
      const slide = gradeUnits.find((u) => u.key === 'spine-window')
      if (slide && n.dist < 120 && Math.abs(n.s - pavedS) >= 500) {
        pavedS = n.s
        spineLo = Math.max(0, n.s - SPINE_WIN)
        spineHi = Math.min(curveLen, n.s + SPINE_WIN)
        slide.x = eye.x
        slide.z = eye.z
        slide.done = false
      }
    }
    void pump()
  }
  // The overview is one mesh for the whole site. Rebuilding its normals per strip was the
  // remaining hitch. Positions still sink; the normals wait until the mesh is actually drawn,
  // and then on the same slice budget so coming back up onto it does not stop the frame.
  let overviewNormalsDirty = false
  let overviewNormalsRunning = false
  const refreshOverviewNormals = async () => {
    if (overviewNormalsRunning || !overview.visible) return
    overviewNormalsRunning = true
    try {
      while (overviewNormalsDirty && overview.visible && !gradePumping) {
        overviewNormalsDirty = false
        const done = await refreshNormals(terrainGeo, new Budget(T.STREAM_BUDGET_MS), () => gradePumping || !overview.visible)
        if (!done) overviewNormalsDirty = true
      }
    } finally {
      overviewNormalsRunning = false
    }
  }
  // the grass generator's road-distance answer, lifted out of the strip block for the Site's probes
  let grassRoadDistanceOut: (x: number, z: number) => number = () => Infinity
  let grassBlockedOut: (x: number, z: number) => boolean = () => false
  let zoneAtOut: (x: number, z: number) => 'kept' | 'rural' | null = () => null
  let roadAtOut: (x: number, z: number) => { name: string | null; ref: string | null; highway: string | null; d: number } | null = () => null
  let edgeInfoOut: (x: number, z: number, exclude?: number, roadsOnly?: boolean) => { d: number; who: number; y: number; s: number; gx: number; gz: number } = () => ({ d: Infinity, who: -1, y: 0, s: 0, gx: 0, gz: 0 })
  let edgeDistanceWorld: (x: number, z: number) => number = () => Infinity
  // the physics ground: the same field, but at a grade-separated crossing it follows the LOWER
  // carriageway (the one graded to the earth) rather than the nearest — the upper one is carried by
  // its own deck collider. Only the physics asks this; the drawn strip must follow the road it draws.
  let physGroundAtOut: (x: number, z: number) => number | null = () => null
  let edgeLevelsOut: (x: number, z: number) => { who: number; y: number; d: number }[] = () => []
  // the elevated carriageways near a point, as drivable trimesh ribbons in the site frame (x east,
  // y north, z up) — the deck colliders that keep a car on a bridge whose ground fell to the road
  // below it. Built once per carriageway and cached.
  let decksNearOut: (x: number, z: number, r: number) => { key: string; positions: Float32Array; indices: Uint32Array }[] = () => []
  let roadInfoWorld: (x: number, z: number) => { d: number; who: number } = () => ({ d: Infinity, who: -1 })
  /** the road surface under a point near a carriageway: the spline's height, which the asphalt is built from */
  let roadHeightWorld: (x: number, z: number) => number | null = () => null
  let treesNearWorld: (x: number, z: number, r: number) => [number, number, number][] = () => []
  let currentSeason: Season = initialSeason
  let grassRef: Grass | null = null
  // the near-tree set and the measured tree list, for probes/corridor-flora.mjs: which silhouettes
  // this site built and which one every one of its tens of thousands of trees drew
  /**
   * Where scenery must not exist: the footprints of the stunt fixtures standing in this world.
   *
   * Rich, 2026-09-29: a fixture is dropped into a wooded corridor and clears nothing, so a loop can
   * have trees growing through it and fence posts inside it — invisible to the eye once you are on
   * the ribbon, entirely solid to the car. The road is already suppressed under a fixture
   * (`setRoadSkip`); this is the rest of that idea.
   *
   * SITE FRAME, x east, y north — the same as a footprint and a polygon everywhere else.
   */
  let clearPolys: [number, number][][] = []
  /*
   * Filled in when the trees are built. The Site surface is returned from the outer scope and the
   * planting lives in the inner one, so clearing ground has to reach in through a pair of hooks —
   * and they default to doing nothing, which is the right answer for a site with no trees at all.
   */
  let reindexTrees: () => void = () => {}
  let replantNow: () => void = () => {}
  const clearedAt = (x: number, y: number): boolean => {
    for (const poly of clearPolys) if (inside(poly, x, y)) return true
    return false
  }
  let nearRef: NearTrees | null = null
  /** the impostor field, for the Site's setLight — a baked card lights itself */
  let impRef: Impostors | null = null
  let shadowRef: TreeShadowCasters | null = null
  /** every physical material that can be wet, with what it looks like dry */
  const wettable = new Map<THREE.MeshStandardMaterial, { roughness: number; metalness: number; env: number; colour: THREE.Color }>()
  let wetNow = 0
  const canBeWet = (o: THREE.Object3D) => {
    o.traverse((c) => {
      const m = (c as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || wettable.has(mat)) continue
        wettable.set(mat, { roughness: mat.roughness, metalness: mat.metalness, env: mat.envMapIntensity ?? 1, colour: mat.color.clone() })
      }
    })
  }
  let forgetCanopy: () => void = () => {}
  let replantAt: (eye: THREE.Vector3, fwd?: THREE.Vector3, pitch?: number) => void = () => {}
  let treeRecords: TreeRecord[] = []
  let treePlantingRef: () => { count: number; cellM: number; radius: number; centre: [number, number]; capped: boolean; replants: number; lastMs: number; pending: number } = () => ({ count: 0, cellM: 0, radius: 0, centre: [0, 0], capped: false, replants: 0, lastMs: 0, pending: 0 })
  let treeCardsRef: () => { nearSet: number; cards: number; inBand: number; doubled: number; band: number; replants: number; uploads: Record<string, number | boolean> | null } = () => ({ nearSet: 0, cards: 0, inBand: 0, doubled: 0, band: 0, replants: 0, uploads: null })
  let crops: ReturnType<typeof buildCrops> | null = null
  let precip: Precipitation | null = null
  let canopyAtRef: (x: number, y: number) => number = () => 0
  if (chm) {
    // distance to the nearest PAVEMENT EDGE of any carriageway (negative = on the pavement):
    // stations every 5 m from the spine and every sibling, hashed on a 20 m grid with each
    // station carrying its own half width. Grass, verges and tree exclusion all ask this.
    const stCell = 20
    const stGrid = new Map<string, { x: number; z: number; dx: number; dz: number; s: number; half: number; who: number; off: number; y?: number; elev?: boolean }[]>()
    // every station of a carriageway, in order — the deck builder walks one whole road to find its
    // elevated runs, and the hashed grid cannot answer that without a full scan
    const stationsByWho: { x: number; z: number; half: number; off: number; s: number; y: number; dx: number; dz: number; elev?: boolean }[][] = []
    // one height function per carriageway: the SAME spline the road mesh is drawn from
    const curves: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number }[] = [{ at: spineAt, len: curveLen }, ...sibAts.map((s) => ({ at: s.at, len: s.len })), ...branchAts.map((b) => ({ at: b.at, len: b.len }))]
    const branchWho0 = 1 + sibAts.length // `who` of the first branch in the station grid
    const halfOf = (who: number, s: number) => (who === 0 ? pavedHalfAt(s) : who < branchWho0 ? pavedWidth(2) / 2 : branchAts[who - branchWho0].half)
    const addStations = (who: number, halfAt: (s: number) => number, offAt: (s: number) => number = () => 0) => {
      const c = curves[who]
      const list: { x: number; z: number; half: number; off: number; s: number; y: number; dx: number; dz: number; elev?: boolean }[] = []
      for (let s = 0; s <= c.len; s += 5) {
        const st = c.at(s)
        const d = st.dir.clone().setY(0).normalize()
        const k = `${Math.floor(st.pos.x / stCell)},${Math.floor(st.pos.z / stCell)}`
        const arr = stGrid.get(k)
        // IS THIS STATION UP IN THE AIR? A carriageway whose spline stands a level above the bare
        // earth is a bridge or an overpass deck, not ground to grade to — it is carried as a trimesh
        // collider instead. See `edgeDistance`'s `grade`. `heightAt` takes site (x, north), so -z.
        const elev = isDeck(st.pos.y, heightAt(st.pos.x, -st.pos.z), T.OVERPASS_CLEAR_M)
        const rec = { x: st.pos.x, z: st.pos.z, dx: d.x, dz: d.z, s, half: halfAt(s), off: offAt(s), who, y: st.pos.y, elev }
        if (arr) arr.push(rec)
        else stGrid.set(k, [rec])
        list.push({ x: st.pos.x, z: st.pos.z, half: rec.half, off: rec.off, s, y: rec.y, dx: d.x, dz: d.z, elev })
      }
      stationsByWho[who] = list
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
    for (let i = 0; i < branchRaw.length; i++) {
      const de = branchRaw[i].br.dead_ends
      if (de?.length) authored.set(branchWho0 + i, de)
    }
    const endsFor = (who: number) => {
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
        return
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
    for (let who = 0; who < curves.length; who++) endsFor(who)
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
    const edgeDistance = (x: number, z: number, exclude = -1, roadsOnly = false, grade = false, skipBranchDecks = false): { d: number; who: number; y: number; s: number; gx: number; gz: number } => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      let best = Infinity, who = -1, bp: (typeof stGrid extends Map<string, (infer R)[]> ? R : never) | null = null
      // how the distance GROWS from the winning station: away from its centreline inside the
      // along-track band, radially outside it. The grass planter needs it to place a blade's own
      // distance from the cell's, without a second (expensive) grid walk per blade.
      let bLat = false, bux = 0, buz = 0
      for (let a = -3; a <= 3; a++) {
        for (let b = -3; b <= 3; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            if (p.who === exclude || (roadsOnly && p.who < 0)) continue
            // THE LEVEL RULE (grade mode, the physics ground): an elevated carriageway is a deck, not
            // the earth, so it is not a candidate at all. The point under an overpass then grades to
            // the road below (or the DEM where there is none), and the overpass rides its own trimesh
            // collider — the "invisible tunnel" under the structure. Without this the ground snapped
            // to whichever deck was laterally nearest, a 7.65 m wall on the Beltway (Paul, 2026-10-06).
            if (grade && p.elev) continue
            // THE GROUND THE STRIP READS IS NOT A DECK OF ANOTHER ROAD. The spine's fine strip
            // (buildStrip) grades up to whatever carriageway pavement is nearest. When a crossing
            // branch rides a deck over the spine — University Blvd over the Beltway, Kenilworth over
            // the Beltway — the bare-earth DEM below is the valley floor, but the strip kept
            // climbing to the branch's deck and left a mound of earth standing in the roadway under
            // the span. The branch's own strip already skips its deck (see the `isDeck` verge rule);
            // here the spine strip must too, so it falls back to the DEM/road below.
            if (skipBranchDecks && p.elev && p.who >= branchWho0) continue
            // lateral distance to the station's tangent, so a point between two stations measures
            // to the road and not to the nearer station's dot
            const ux = x - p.x, uz = z - p.z
            const along = ux * p.dx + uz * p.dz
            // signed lateral, + to the right of travel (right = dir x UP = (-dz, 0, dx)), measured
            // from the asphalt's centre rather than the spine; with off = 0 this is the old |lat|
            const lat = Math.abs(uz * p.dx - ux * p.dz - p.off)
            /*
             * THE BAND HAS TO OVERLAP, or there is a wedge between stations with nothing in it.
             *
             * Inside the band the distance is measured laterally from the station's tangent;
             * outside it, radially from the station itself, which is what makes a lone station a
             * disc and gives cul-de-sac bulbs their shape for free. Stations are 5 m apart, so a
             * band of +/-2.6 m covers 5.2 m — twenty centimetres of overlap, on a STRAIGHT road.
             * On the outside of a bend consecutive tangent bands fan apart, the overlap goes, and
             * a point in the wedge falls through to the radial branch, which over-reports by
             * roughly along^2 / (2 * half) — about 0.85 m. The road mesh interpolates its ribbon
             * continuously between the same stations and has no such wedge, so the asphalt
             * reached past what the field believed and grass grew on it.
             *
             * A wider band closes the wedge and errs the safe way: the tangent leans INSIDE the
             * curve, so a lateral measure taken a little further along under-reports the distance
             * and keeps grass off rather than letting it on.
             */
            const d = (Math.abs(along) <= T.EDGE_BAND_M ? lat : Math.hypot(ux, uz)) - p.half
            if (d < best) { best = d; who = p.who; bp = p; bLat = Math.abs(along) <= T.EDGE_BAND_M; bux = ux; buz = uz }
          }
        }
      }
      if (!bp) return { d: best, who, y: 0, s: 0, gx: 0, gz: 0 }
      // a driveway (who < 0) is not a carriageway and has no spline: it carries its own height
      const grad = (): [number, number] => {
        if (bLat) {
          const sgn = Math.sign(buz * bp!.dx - bux * bp!.dz - bp!.off) || 1
          return [-bp!.dz * sgn, bp!.dx * sgn]
        }
        const L = Math.hypot(bux, buz) || 1
        return [bux / L, buz / L]
      }
      if (bp.who < 0) { const [gx, gz] = grad(); return { d: best, who: bp.who, y: bp.y ?? 0, s: 0, gx, gz } }
      // the road height HERE, from the carriageway spline at the projected along-track metre —
      // the very same function the asphalt mesh is built from, so ground and road agree to the mm
      const along = (x - bp.x) * bp.dx + (z - bp.z) * bp.dz
      const c = curves[bp.who]
      const sOn = Math.min(c.len, Math.max(0, bp.s + along))
      const y = c.at(sOn).pos.y // the spline IS the road surface
      const [gx, gz] = grad()
      return { d: best, who: bp.who, y, s: sOn, gx, gz }
    }
    const roadDistance = (x: number, z: number) => edgeDistance(x, z).d
    /**
     * EVERY carriageway whose pavement covers a point, lowest first — the raw vertical picture at a
     * crossing, for QA and probes. `edgeInfo` returns only the winner, which is exactly the fact a
     * grade-separation bug hides behind.
     */
    const edgeLevelsAt = (x: number, z: number): { who: number; y: number; d: number }[] => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      const byWho = new Map<number, { who: number; y: number; d: number }>()
      for (let a = -3; a <= 3; a++) {
        for (let b = -3; b <= 3; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            if (p.who < 0 || p.y === undefined) continue
            const ux = x - p.x, uz = z - p.z
            const along = ux * p.dx + uz * p.dz
            const lat = Math.abs(uz * p.dx - ux * p.dz - p.off)
            const d = (Math.abs(along) <= T.EDGE_BAND_M ? lat : Math.hypot(ux, uz)) - p.half
            if (d > T.OVERPASS_COVER_M) continue
            const had = byWho.get(p.who)
            if (!had || d < had.d) byWho.set(p.who, { who: p.who, y: p.y, d })
          }
        }
      }
      return [...byWho.values()].sort((a, b) => a.y - b.y)
    }
    edgeLevelsOut = edgeLevelsAt
    /**
     * THE ELEVATED DECKS NEAR A POINT, as drivable ribbons.
     *
     * The physics ground is one height per column, so at a grade-separated crossing it can only be
     * the LOWER carriageway; the upper one has to be a real surface of its own or the car falls
     * through it the moment the ground switches (Paul, 2026-10-06). This builds that surface: for
     * every carriageway with a station near the point, walk its whole station list and emit a
     * triangle ribbon over the stretches where its spline stands more than OVERPASS_CLEAR_M above
     * the bare earth. A trimesh, the same shape a stunt loop uses, because only a trimesh can be a
     * road that is above itself.
     *
     * Site frame (x east, y north, z up) — `addSurface` converts to the physics frame once.
     */
    const deckCache = new Map<number, { positions: Float32Array; indices: Uint32Array } | null>()
    /**
     * Does this carriageway station merely duplicate a WIDER one on the same line?
     *
     * An OSM interchange's ramp shares the main road's centreline — its shape points sit on it — a
     * metre higher. That is not a second structure: the wider road is already there, drawn and
     * collided. The ramp's own surface, deck collider and bridge concrete are all suppressed where
     * this is true, or the hero car wedges under asphalt nobody can see (Rich, 2026-10-06). The
     * parallel-direction test keeps at-grade cross streets — which run ACROSS us — out of it.
     */
    const dupAt = (self: number, x: number, y: number, z: number, half: number, hx: number, hz: number): boolean => {
      const c0 = Math.floor(x / stCell), c1 = Math.floor(z / stCell)
      const rr = Math.ceil((half + 3) / stCell)
      for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) {
        for (const p of stGrid.get(`${c0 + a},${c1 + b}`) ?? []) {
          if (p.who === self) continue
          if (!(p.half > half + 0.5)) continue
          if (p.y == null || Math.abs(p.y - y) > 2.5) continue
          if (p.dx * hx + p.dz * hz < 0.7) continue
          if (Math.abs((p.x - x) * hz - (p.z - z) * hx) > half + 0.5) continue
          return true
        }
      }
      return false
    }
    const buildDeck = (who: number) => deckRibbon(stationsByWho[who], heightAt, T.OVERPASS_CLEAR_M, (a, b) => {
      const hx = b.x - a.x, hz = b.z - a.z
      const h = Math.hypot(hx, hz) || 1
      return dupAt(who, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, (a.half + b.half) / 2, hx / h, hz / h)
    })
    decksNearOut = (x, z, r) => {
      const n = Math.ceil(r / stCell) + 1
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      const whos = new Set<number>()
      for (let a = -n; a <= n; a++) {
        for (let b = -n; b <= n; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            if (p.who < 0) continue
            const ddx = p.x - x, ddz = p.z - z
            if (ddx * ddx + ddz * ddz <= r * r) whos.add(p.who)
          }
        }
      }
      const out: { key: string; positions: Float32Array; indices: Uint32Array }[] = []
      for (const who of whos) {
        let g = deckCache.get(who)
        if (g === undefined) {
          if (deckCache.size > 2048) deckCache.clear()
          g = buildDeck(who)
          deckCache.set(who, g)
        }
        if (g) out.push({ key: `deck:${who}`, positions: g.positions, indices: g.indices })
      }
      return out
    }
    /**
     * Is pavement within `limit` metres? The tree planter asks this of every new cell. The full
     * edge walk is a 7×7 of station cells plus the spline, which grass needs (gradient and height).
     * A tree only needs a yes inside `TREE_ROAD_CLEAR_M`, so a smaller square of station cells is
     * enough; it widens with the limit so the rule holds if the knob does.
     */
    const withinPavement = (x: number, z: number, limit: number) => {
      const cx = Math.floor(x / stCell), cz = Math.floor(z / stCell)
      // a station within `limit` metres sits in this cell or one beside it, so the walk grows with
      // the limit rather than being pinned to the old three-by-three
      const n = Math.ceil(limit / stCell) + 1
      for (let a = -n; a <= n; a++) {
        for (let b = -n; b <= n; b++) {
          const arr = stGrid.get(`${cx + a},${cz + b}`)
          if (!arr) continue
          for (const p of arr) {
            const ux = x - p.x, uz = z - p.z
            const along = ux * p.dx + uz * p.dz
            const lat = Math.abs(uz * p.dx - ux * p.dz - p.off)
            const d = (Math.abs(along) <= T.EDGE_BAND_M ? lat : Math.hypot(ux, uz)) - p.half
            if (d < limit) return true
          }
        }
      }
      return false
    }
    // A CAR PARK IS NOT A VERGE. The grass planter only knows how far it is from the pavement
    // EDGE, and a lot sits beyond that edge, so turf was growing straight across the asphalt —
    // visible as green tufts over any open lot. Parking meshes are built much later than the
    // grass, so the cover comes from the manifest directly.
    const onParking = parkingCover(manifest)
    const onSidewalk = sidewalkCover(manifest)
    // -1 means "do not plant here": a mapped lot or a walk.
    /*
     * WHERE GRASS MAY NOT GROW, decided by THE GROUND, not by a second opinion about the air photo.
     *
     * The verge is painted grass by strip.ts everywhere the pavement, a lot or a walk does not cover
     * it, and grass should follow the same rule: plant it wherever that ground is grass-textured.
     * The old test also consulted the vegetation mask and the paving classifier, and those were a
     * THIRD verdict that disagreed with the picture the strip paints — whole grass-textured medians
     * and verges were classified "not vegetation" or "paved" and left as flat photo turf with no
     * blades (Rich 2026-10-04: "what's up with all this not grass?"; "decide where grass grows based
     * on where the grass texture is"). A car park, a walk and the carriageway are explicit covers
     * the grass already tests for, so keep those; drop the image classifiers.
     */
    const grassBlocked = (x: number, z: number) => onParking(x, z) || onSidewalk(x, z)
    // -1 is a SENTINEL here, not a distance: "no grass, whatever the geometry says".
    const grassRoadDistance = (x: number, z: number) => (grassBlocked(x, z) ? -1 : roadDistance(x, z))
    grassRoadDistanceOut = grassRoadDistance
    grassBlockedOut = grassBlocked
    edgeInfoOut = edgeDistance

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
    const grassTex = (cls: string) => ((roadSets[cls]?.material as THREE.MeshStandardMaterial | undefined)?.map ?? null)
    // the CHM the grass generator already rejects cells by; the strip needs it to know where the
    // ground is forest floor rather than turf
    mark('grade: lateral extent')
    const stripCanopyAt = chm ? sampler(chm) : null
    // the forest floor is the site's dominant TREE ground class: spruce duff at Acadia, bay and
    // live-oak litter at Big Sur, the oak-hickory that used to be painted everywhere in Maryland
    const litter = renderer && chm ? floorTexture(cover.floor) : null
    mark('grade: floor texture')
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
    mark('grade: setup')
    // --- THE GROUND IS A FORMULA, NOT A MESH -------------------------------------------------
    // Exactly what a strip vertex computes (strip.ts): road grade under and just beside the
    // pavement, blended to the DEM over 0.6–7 m, plus the editor's ground offset — answered here
    // straight from edgeDistance. The car, the grass, the furniture and the buildings all stand on
    // this, whether or not the strip MESH near them exists yet, which is what lets the meshes be
    // built lazily around the eye instead of 427 of them at load. Past the verge, and past a
    // parapet on the primary, it answers null and the caller falls back to the DEM.
    const offsetFn = adjustments.active ? (x: number, y: number) => adjustments.at(x, y, adjScratch).ground_offset_m : null
    const gradedHeight = (x: number, z: number, grade = false): number | null => {
      const e = edgeDistance(x, z, -1, false, grade)
      if (!Number.isFinite(e.d)) return null
      const primary = e.who < branchWho0
      if (e.d > (primary ? VERGE : T.BRANCH_VERGE)) return null
      if (primary && e.d > stripEdgeLimitAt(e.s)) return null
      // ... and the spine's ground must not climb to a crossing BRANCH's deck. University Blvd over
      // the Beltway rides a deck whose bare-earth DEM below is the valley floor, but the ground
      // formula kept following the deck and stood a mound of earth in the underpass roadway. Keep
      // the pavement itself (objects on the deck still stand on it); drop the verge to the DEM.
      if (!primary && e.d > 0.6 && isDeck(e.y, heightAt(x, -z), T.OVERPASS_CLEAR_M)) return null
      const t = THREE.MathUtils.smoothstep(e.d, 0.6, 7.0)
      const off = offsetFn ? offsetFn(x, -z) * t : 0
      // THE TURF LIP (buildStrip). The mesh stands the grass-scaled lip proud of the pavement over
      // its ramp; if this model omits it, every blade (and the car) inside the ramp is placed UNDER
      // the mesh and is never seen — which is why no blades ever defined the raised edge.
      const ramp = primary ? 0.6 : 2.4
      const lift = e.d > 0 ? T.grassLipM() * Math.min(1, e.d / ramp) : 0
      return (e.d < 0.6 ? e.y - 0.02 : (e.y - 0.02) * (1 - t) + heightAt(x, -z) * t) + off + lift
    }
    type LiveStrip = Awaited<ReturnType<typeof buildStrip>>
    const liveStrips: LiveStrip[] = []
    // the terrain surfaces a new strip must sink: every geometry whose box it touches, not all 60
    const terrainBoxes = terrainGeos.map((g) => { g.computeBoundingBox(); const b = g.boundingBox!; return { g, x0: b.min.x, z0: b.min.z, x1: b.max.x, z1: b.max.z } })
    const dressStrip = (st: LiveStrip) => {
      const lk = look(currentSeason)
      st.setTint(lk.grass.base.clone().multiplyScalar(2.0).lerp(new THREE.Color(0xffffff), 0.4), imagery ? lk.ground : bare)
      st.setLitter(lk.litter.tint, lk.litter.spread)
      st.setImageryDesat(STYLE[currentStyle].desaturate)
      precip?.follow(st.weatherUniforms)
    }
    const adoptStrip = async (st: LiveStrip, budget: Budget) => {
      // Sink before the mesh joins the scene. The terrain buffer is not uploaded until the sink
      // finishes, so a yielded sink does not show a trench and the strip does not z-fight it.
      const [x0, z0, x1, z1] = st.bounds
      for (const b of terrainBoxes) {
        if (x1 + 10 < b.x0 || x0 - 10 > b.x1 || z1 + 10 < b.z0 || z0 - 10 > b.z1) continue
        const overviewMesh = b.g === terrainGeo
        await sinkUnderStrips(b.g, [st], 9, 3.5, budget, !overviewMesh)
        if (overviewMesh) overviewNormalsDirty = true
      }
      road.add(st.mesh)
      liveStrips.push(st)
      gradeStats.strips++
      dressStrip(st)
    }
    const edgeAt = (x: number, z: number) => edgeDistance(x, z)
    // the spine strip must not grade up to a crossing branch's deck (see `skipBranchDecks`)
    const edgeAtSpine = (x: number, z: number) => edgeDistance(x, z, -1, false, false, true)
    // the primary in chunks along s: a chunk's stations start at its own s0, so two chunks meet
    // on identical vertices and the seam is exact
    const CHUNK = T.STREAM_CHUNK_M
    const spineUnits: GradeUnit[] = []
    for (let s0 = 0; s0 < curveLen; s0 += CHUNK) {
      const s1 = Math.min(curveLen, s0 + CHUNK)
      const mid = spineAt((s0 + s1) / 2).pos
      spineUnits.push({ key: `spine:${Math.round(s0)}`, x: mid.x, z: mid.z, r: (s1 - s0) / 2 + VERGE + 60, done: false, run: async (budget) => {
        await adoptStrip(await buildStrip((s) => spineAt(s0 + s), s1 - s0, -latMin + VERGE, latMax + VERGE, edgeAtSpine, heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 2, lite ? 2 : 1, offsetFn, null, (s) => stripEdgeLimitAt(s0 + s), stripCanopyAt, litter, budget), budget)
      } })
    }
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
    // A BRANCH LONGER THAN A CHUNK IS CHUNKED LIKE THE PRIMARY, so no unit is bigger than
    // STREAM_CHUNK_M of road: the biggest branch on crownsville took 480 ms headless as one unit.
    // The fill itself yields inside that chunk. The branch's asphalt and paint (one mesh for the
    // whole road) are built by whichever of its chunks the eye reaches first, on the same budget.
    /*
     * A BRIDGE WE ONLY EVER MEET FROM BELOW.
     *
     * The manifest's structures run along the spine, but the carriageway that crosses over us —
     * Kenilworth Ave (MD 201/459) over the Beltway — arrives later as a streamed branch way with no
     * `bridge` record of its own: the bake left only a lidar `gantry`, so nothing built a structure,
     * and from the underpass the crossing road read as a black band of asphalt sky. Walk each
     * branch once and give every genuinely elevated run the concrete the spine's bridges get: a
     * slab under the deck, an edge beam beneath each shoulder, and a parapet on top. The deck the
     * car drives is still the road ribbon; this is only what makes it a bridge to the road below
     * (case 2, docs/corridor/PLAN-GRADE-SEPARATION-RENDER.md). Rich, 2026-10-06.
     */
    const branchBridgeMat = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.9 })
    const bridgeYaw = (d: THREE.Vector3) => Math.atan2(d.x, d.z)
    /** one group of concrete per branch, so a junction-warped rebuild replaces it instead of doubling */
    const branchBridgeFor: (THREE.Group | null)[] = []
    const addBranchBridge = (i: number, self: number, list: { x: number; z: number; y: number; half: number; s: number; elev?: boolean }[]) => {
      const old = branchBridgeFor[i]
      if (old) {
        branchBridges.remove(old)
        old.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
        branchBridgeFor[i] = null
      }
      if (!list || list.length < 2) return
      const up = new THREE.Vector3(0, 1, 0)
      const parts: THREE.BufferGeometry[] = []
      const m4 = new THREE.Matrix4()
      const place = (geo: THREE.BufferGeometry, x: number, y: number, z: number, ry: number) => {
        m4.makeRotationY(ry)
        m4.setPosition(x, y, z)
        geo.applyMatrix4(m4)
        parts.push(geo)
      }
      /*
       * A deck, not fill. `isDeck` fires along every fill embankment too — the bare-earth DEM sits
       * below a road graded up to its crown — and drawing concrete there fenced the whole corridor:
       * one branch merged 99,840 verts spanning the map, and Rich read the slabs standing beside the
       * roadway as "a second bridge with a different lane of traffic inside the first" (2026-10-06).
       * Concrete is only correct where the deck genuinely spans OPEN AIR, so ask the station grid
       * whether a carriageway of another `who` passes UNDER this footprint.
       */
      const stCellM = 20
      /**
       * Why this segment is, or is not, part of a bridge.
       *
       * 0 — nothing under it and nothing on top: leave it alone.
       * 1 — a carriageway of another `who` passes UNDER the footprint: a real deck, build it.
       * 2 — a wider carriageway lies ON the footprint at nearly our height. This is the OSM
       *     interchange's shape-point artefact: a ramp (`motorway_link`, one lane) whose centreline
       *     is the same line as the main road it leaves, 1 m higher. Building its deck draws a
       *     second slab and guard rail floating directly over the first — Rich's "second road with
       *     its own guard rails… one is floating above the other roadway" (2026-10-06). The wider
       *     road's deck already stands for the structure; keep that one and stand down.
       */
      const deckStatus = (cx: number, cy: number, cz: number, w: number, half: number, hx: number, hz: number, halfLen: number): 0 | 1 | 2 => {
        const c0 = Math.floor(cx / stCellM), c1 = Math.floor(cz / stCellM)
        const r = Math.ceil((w + halfLen + 8) / stCellM)
        let span = 0
        for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
          for (const p of stGrid.get(`${c0 + a},${c1 + b}`) ?? []) {
            if (p.who === self) continue
            const ux = p.x - cx, uz = p.z - cz
            // lateral distance from this segment's centreline, and distance along it
            const along = ux * hx + uz * hz
            if (Math.abs(along) > halfLen + 4) continue
            const lat = Math.abs(ux * hz - uz * hx)
            if (lat > w) continue          // they must be on our footprint, not merely nearby
            if (p.y == null) continue
            if (p.y < cy - T.OVERPASS_CLEAR_M) { span = 1; continue }
            // at nearly our height and within our half-width: a duplicate alignment, ours to cede,
            // but only if it runs WITH us — an at-grade cross street is not a duplicate
            if (p.half > half + 0.5 && Math.abs(p.y - cy) <= 2.5 && lat <= half + 0.5 && p.dx * hx + p.dz * hz >= 0.7) return 2
          }
        }
        return span as 0 | 1
      }
      // Walk the deck segment by segment, then decide which segments are truly over open air. A
      // segment-by-segment decision alone flickers: a ramp wanders in and out of the deck's
      // footprint, so a lone slab would stand with clear air either side of it and Rich read the
      // result as "a second bridge with a different lane of traffic inside the first" (2026-10-06).
      // Gather first, smooth the run, then build — so a deck is one continuous piece or nothing.
      type Seg = { dx: number; dz: number; seg: number; l: number; w: number; cx: number; cy: number; cz: number; sx: number; sz: number; ry: number; ok: boolean }
      const segs: Seg[] = []
      for (let k = 0; k + 1 < list.length; k++) {
        const A = list[k], B = list[k + 1]
        // A genuine deck, not fill: the station grid already carries the isDeck flag, so this walk
        // costs no extra DEM samples. (Walking the curve at 4 m with a heightAt per step made a
        // single branch unit take a 7 s slice — Rich's underpass probe, 2026-10-06.)
        if (!A.elev || !B.elev) { segs.push(null as unknown as Seg); continue }
        if (Math.abs(B.s - A.s) > 12) { segs.push(null as unknown as Seg); continue } // a gap in the road, not a deck
        const dx = B.x - A.x, dz = B.z - A.z
        const seg = Math.hypot(dx, dz)
        if (seg < 0.5 || seg > 12) { segs.push(null as unknown as Seg); continue }
        const half = (A.half + B.half) / 2
        const w = half + 0.6
        const dir = new THREE.Vector3(dx, B.y - A.y, dz)
        const l = dir.length() + 0.05
        dir.normalize()
        const side = dir.clone().cross(up)
        const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2, cz = (A.z + B.z) / 2
        segs.push({
          dx, dz, seg, l, w, cx, cy, cz,
          sx: side.x, sz: side.z, ry: bridgeYaw(dir),
          ok: deckStatus(cx, cy, cz, w, half, dx / seg, dz / seg, seg / 2) === 1,
        })
      }
      // A slab earns its keep only as part of a run: drop any segment whose neighbours do not span.
      // The fascia then reads as one bridge, not a stutter of disconnected walls.
      for (let k = 0; k < segs.length; k++) {
        if (!segs[k]?.ok) continue
        if (!segs[k - 1]?.ok && !segs[k + 1]?.ok) segs[k].ok = false
      }
      for (const s of segs) {
        if (!s?.ok) continue
        const { l, w, cx, cy, cz, sx, sz, ry } = s
        place(new THREE.BoxGeometry(2 * (w - 0.3), 0.5, l), cx, cy - 1.35, cz, ry)
        for (const sgn of [-1, 1]) {
          place(new THREE.BoxGeometry(0.4, 1.0, l), cx + sx * sgn * w, cy + 0.5, cz + sz * sgn * w, ry)
          place(new THREE.BoxGeometry(0.8, 1.6, l), cx + sx * sgn * (w - 0.3), cy - 0.9, cz + sz * sgn * (w - 0.3), ry)
        }
      }
      if (!parts.length) return
      // ONE MESH. A long elevated run emits thousands of boxes; as separate meshes that is thousands
      // of draw calls (a probe measured 4,000 for a single branch). Merged, it is one.
      const g = new THREE.Group()
      branchBridgeFor[i] = g
      branchBridges.add(g)
      g.add(new THREE.Mesh(mergeGeometries(parts, false), branchBridgeMat))
    }
    const branchUnits: GradeUnit[] = []
    // ONE MESH PER CHUNK, NOT ONE PER BRANCH. A branch can be a motorway ring 60 km long — the two
    // Capital Beltway carriageways are 63.0 and 61.9 km — and building a whole one in a single pump
    // unit means the pump cannot build anything else, and nothing appears, until all 60 km are done.
    // At speed the road you have just driven onto therefore waits behind a carriageway you are
    // nowhere near ("the inner loop baked but the outer loop didn't resolve for a minute", Rich,
    // 2026-10-07). Each chunk's pump unit now builds only its own slice, on the SAME 6 m station grid
    // as a whole-branch build, so the pieces abut exactly and the lane-dash phase is continuous.
    interface BranchRoad { base: (THREE.Object3D | null)[]; holed: (THREE.Object3D | null)[] }
    const branchRoad: BranchRoad[] = branchAts.map(() => ({ base: [], holed: [] }))
    // which chunks have been built, so a junction warp rebuilds just those
    const chunkBuilt = new Set<string>()
    const bridgeDone = new Set<number>()
    /** chunk k's stations, on the global 6 m grid with ABSOLUTE `s` (roadMesh reads `s mod 12`) */
    const segStations = (b: { at: (s: number) => { pos: THREE.Vector3; dir: THREE.Vector3 }; len: number }, k: number) => {
      const [ia, ib] = chunkStations(b.len, k, CHUNK)
      const st: { pos: THREE.Vector3; dir: THREE.Vector3; s: number }[] = []
      for (let q = ia; q <= ib; q++) {
        const s = q * 6
        const p = b.at(s)
        st.push({ pos: p.pos, dir: p.dir.clone().setY(0).normalize(), s })
      }
      return st
    }
    const holeBranchChunk = (i: number, k: number) => {
      const r = branchRoad[i]
      const base = r.base[k]
      if (!base) return
      if (r.holed[k]) { forget(r.holed[k]!); r.holed[k] = null }
      const b = branchAts[i]
      const skip = roadSkip
      let touched = false
      if (skip) { const [ia, ib] = chunkStations(b.len, k, CHUNK); for (let q = ia; q <= ib && !touched; q++) touched = skip(i + 1, q * 6) }
      if (!touched) { base.visible = true; return }
      const rm = roadMesh(segStations(b, k), () => b.lanes, () => 'asphalt_aged', roadSets, 0.02, () => b.twoWay, paintOff, () => isKerbed(b.highway), (s) => duplicatesWider(i, s) || skip!(i + 1, s))
      if (paintNow) repaintMarkings(rm, paintNow.centre, paintNow.edge)
      road.add(rm)
      roadParts.push(rm)
      r.holed[k] = rm
      base.visible = false
    }
    const holeBranch = (i: number) => { for (let k = 0; k < branchRoad[i].base.length; k++) holeBranchChunk(i, k) }
    holeBranches = () => { for (let i = 0; i < branchAts.length; i++) holeBranch(i) }
    /**
     * Is this branch station merely a second ribbon over a wider carriageway?
     *
     * An OSM interchange's ramp shares the main road's centreline — its shape points sit on it — a
     * metre higher. Suppressing the ramp's BRIDGE concrete (see `deckStatus`) still left its ASPHALT
     * drawn a metre above the main road: Rich's "random chunk of road" (2026-10-06). Where a wider
     * carriageway runs WITH us, at our height and on our line, the wider road's surface already
     * stands there, so draw none of our own. A cross street at grade fails the parallel test.
     */
    const duplicatesWider = (i: number, s: number): boolean => {
      const r = branchAts[i].at(s)
      const q = r.pos
      const h = Math.hypot(r.dir.x, r.dir.z) || 1
      return dupAt(branchWho0 + i, q.x, q.y, q.z, branchAts[i].half, r.dir.x / h, r.dir.z / h)
    }
    const buildBranchChunk = async (i: number, k: number, budget: Budget) => {
      const key = `${i}:${k}`
      if (chunkBuilt.has(key)) return
      const b = branchAts[i]
      const st = segStations(b, k)
      if (st.length < 2) return
      chunkBuilt.add(key)
      const rm = await roadMeshPaced(st, () => b.lanes, () => 'asphalt_aged', roadSets, 0.02, () => b.twoWay, paintOff, () => isKerbed(b.highway), (s) => duplicatesWider(i, s), budget)
      if (paintNow) repaintMarkings(rm, paintNow.centre, paintNow.edge)
      road.add(rm)
      roadParts.push(rm)
      branchRoad[i].base[k] = rm
      // the bridge concrete is one mesh per branch, not per chunk — build it once, on the first chunk
      if (!bridgeDone.has(i)) { bridgeDone.add(i); addBranchBridge(i, branchWho0 + i, stationsByWho[branchWho0 + i]) }
      holeBranchChunk(i, k)
    }
    branchAts.forEach((b, i) => {
      // A station is left out only where another CARRIAGEWAY's strip covers it. The rule used to
      // ask the nearest station of any other `who`, and a driveway (who -2) counted: every station
      // beside a driveway was skipped, nothing covered the hole, the terrain under it was never
      // sunk, and the coarse terrain stood 0.4-0.9 m above the road as a dark blob (Saint
      // Stephens Church Road, crownsville, measured in probes/corridor-crosssection.mjs).
      const skip = (s: number) => {
        const q = b.at(s).pos
        // ... and a branch on a DECK emits no verge at all: this is the crossing carriageway over
        // the underpass (Kenilworth Ave over the Beltway), whose graded fill used to climb onto the
        // span and stand in the roadway below — the "DEM in the underpass" Rich kept driving into.
        // The pavement mesh still carries the car; only the grass verge goes.
        if (isDeck(q.y, heightAt(q.x, -q.z), T.OVERPASS_CLEAR_M)) return true
        return edgeDistance(q.x, q.z, branchWho0 + i, true).d < T.BRANCH_VERGE
      }
      const nChunks = Math.max(1, Math.ceil(b.len / CHUNK))
      for (let k = 0; k < nChunks; k++) {
        const s0 = (k * b.len) / nChunks, s1 = ((k + 1) * b.len) / nChunks
        let x0: number, z0: number, x1: number, z1: number
        if (nChunks === 1) [x0, z0, x1, z1] = b.bounds
        else {
          // this chunk's own extent, sampled along its metres
          x0 = Infinity; z0 = Infinity; x1 = -Infinity; z1 = -Infinity
          for (let s = s0; s <= s1; s += 20) { const q = b.at(s).pos; if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z }
        }
        branchUnits.push({ key: `branch:${i}:${k}`, x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2 + T.BRANCH_VERGE + 20, done: false, run: async (budget) => {
          await buildBranchChunk(i, k, budget)
          await adoptStrip(await buildStrip((s) => b.at(s0 + s), s1 - s0, T.BRANCH_VERGE, T.BRANCH_VERGE, edgeAt, heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 3, lite ? 3 : 2, offsetFn, (s) => skip(s0 + s), null, null, null, budget), budget)
        } })
      }
    })
    const queueBranch = (i: number, into: GradeUnit[]) => {
      const b = branchAts[i]
      const skip = (s: number) => {
        const q = b.at(s).pos
        // ... and a branch on a DECK emits no verge at all: this is the crossing carriageway over
        // the underpass (Kenilworth Ave over the Beltway), whose graded fill used to climb onto the
        // span and stand in the roadway below — the "DEM in the underpass" Rich kept driving into.
        // The pavement mesh still carries the car; only the grass verge goes.
        if (isDeck(q.y, heightAt(q.x, -q.z), T.OVERPASS_CLEAR_M)) return true
        return edgeDistance(q.x, q.z, branchWho0 + i, true).d < T.BRANCH_VERGE
      }
      const nChunks = Math.max(1, Math.ceil(b.len / CHUNK))
      for (let k = 0; k < nChunks; k++) {
        const s0 = (k * b.len) / nChunks, s1 = ((k + 1) * b.len) / nChunks
        let x0: number, z0: number, x1: number, z1: number
        if (nChunks === 1) [x0, z0, x1, z1] = b.bounds
        else {
          x0 = Infinity; z0 = Infinity; x1 = -Infinity; z1 = -Infinity
          for (let s = s0; s <= s1; s += 20) { const q = b.at(s).pos; if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z }
        }
        into.push({ key: `branch:${i}:${k}`, x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2 + T.BRANCH_VERGE + 20, done: false, run: async (budget) => {
          await buildBranchChunk(i, k, budget)
          await adoptStrip(await buildStrip((s) => b.at(s0 + s), s1 - s0, T.BRANCH_VERGE, T.BRANCH_VERGE, edgeAt, heightAt, imagery, manifest.bbox, grassTex('grass_mown'), grassTex('grass_rough'), lite ? 4 : 3, lite ? 3 : 2, offsetFn, (s) => skip(s0 + s), null, null, null, budget), budget)
        } })
      }
    }
    // The forEach above already queued the branches taken at startup. This is the same queue
    // for a branch that arrives later, pushed straight onto the pump.
    const adoptArriving = async (br: NonNullable<Manifest['branches']>[number], budget: Budget) => {
      await budget.tick()
      if (!takeBranch(br)) return
      branchRoad.push({ base: [], holed: [] })
      const warped = await finishJunctions(budget)
      const i = branchAts.length - 1
      const b = branchAts[i]
      curves.push({ at: b.at, len: b.len })
      await budget.tick()
      addStations(branchWho0 + i, () => b.half)
      const de = br.dead_ends
      if (de?.length) authored.set(branchWho0 + i, de)
      endsFor(branchWho0 + i)
      placeBulbs()
      // The new asphalt (and its stations) can run under trees already planted in this box. Send
      // them back to the planter's cursor so a trunk the pavement now covers is dropped instead of
      // left standing in the lane for the mask to hide.
      const [bx0, bz0, bx1, bz1] = b.bounds
      t.invalidateRegion(bx0, bz0, bx1, bz1)
      replantNow()
      await budget.tick()
      queueBranch(i, gradeUnits)
      for (const w of warped) {
        const r = branchRoad[w]
        if (!r) continue
        const builtKs: number[] = []
        for (let k = 0; k < r.base.length; k++) if (r.base[k]) builtKs.push(k)
        if (!builtKs.length) continue
        for (const o of r.base) if (o) forget(o)
        for (const o of r.holed) if (o) forget(o)
        r.base = []
        r.holed = []
        // the curve moved, so the concrete over this branch is stale too — let the first rebuilt
        // chunk put it back (addBranchBridge replaces the old group rather than doubling it)
        bridgeDone.delete(w)
        for (const k of builtKs) { chunkBuilt.delete(`${w}:${k}`); await buildBranchChunk(w, k, budget) }
      }
    }
    for (const br of laterBranches) {
      if (!br.coords || br.coords.length < 2) continue
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const p of br.coords) {
        if (p[0] < x0) x0 = p[0]
        if (p[0] > x1) x1 = p[0]
        if (p[1] < y0) y0 = p[1]
        if (p[1] > y1) y1 = p[1]
      }
      const z0 = -y1, z1 = -y0
      gradeUnits.push({
        key: `branch-arrive:${br.id ?? `${x0},${y0}`}`,
        x: (x0 + x1) / 2,
        z: (z0 + z1) / 2,
        r: Math.hypot(x1 - x0, z1 - z0) / 2 + 40,
        done: false,
        run: (budget) => adoptArriving(br, budget),
      })
    }
    if (branchTiled) {
      // Every non-home branch tile becomes one pump unit. It hydrates the cell (relief, junction
      // facts, driveways), indexes the cell's branch segments for the crosswalk pass, then adopts
      // each branch: meet, stations, asphalt — exactly as `laterBranches` did for a resident world.
      for (const t of branchTiles) {
        if (inHomeBranchCell(t)) continue
        const k = `${t.x},${t.y}`
        gradeUnits.push({
          key: `branch-cell:${k}`,
          x: t.x * branchSize + branchSize / 2,
          z: -(t.y * branchSize + branchSize / 2),
          r: branchSize * 0.71 + 40,
          done: false,
          run: async (budget) => {
            const files = await loadVectorTile(manifest.slug, manifest.vt!.dir, t.x, t.y)
            await hydrateCell(k, files, budget)
            for (const br of (files.branches ?? []) as NonNullable<Manifest['branches']>) {
              indexBranchSegment(br)
              await adoptArriving(br, budget)
            }
          },
        })
      }
    }
    gradeUnits.push(...spineUnits, ...branchUnits)
    mark('grade: units listed')
    // --- driveways -------------------------------------------------------------------------
    // Every house on Rich's court has one in OSM and we were dropping them, so the houses stood
    // in grass. Unmarked asphalt, 3.2 m, laid on the strip where the strip covers them and on the
    // DEM grade beyond it. They get stations too, so grass and trees keep off them and the car
    // knows it is on pavement when it pulls in.
    const driveGroup = new THREE.Group()
    driveGroup.name = 'driveways'
    road.add(driveGroup)
    const driveStations: St[] = []
    const clearDriveways = () => {
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
    }
    /** Lay one batch of driveways and stubs as road-group ribbons. Batched because a tiled world
     *  streams them a cell at a time rather than holding 40 MB resident; the load path lays all of
     *  them at once. Stations join `stGrid`, so grass, trees and the car know the asphalt is there. */
    const addDriveways = (driveways: NonNullable<Manifest['driveways']>, stubs: NonNullable<Manifest['stubs']>) => {
      const set = surfaceSets?.asphalt_aged
      const mat = set ? set.material : new THREE.MeshStandardMaterial({ color: 0x3b3b3d, roughness: 1 })
      const mpt = set?.metresPerTile ?? 1
      const pos: number[] = [], uv: number[] = [], idx: number[] = []
      const ribbons: { coords: [number, number, number][]; width: number; flare?: boolean }[] = [
        // a driveway meets the road at a dropped kerb, not a flared mouth
        ...driveways.map((d) => ({ coords: d.coords, width: d.width_m ?? 3.6, flare: false })),
        // a road we do not model, stubbed in from the junction: full width, still unmarked —
        // paint on a 60 m stub that ends in nothing would draw the eye to the seam
        ...stubs.map((s) => ({ coords: s.coords, width: Math.max(5.5, (s.lanes ?? 2) * 3.1 + 0.8), flare: true })),
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
    const makeDriveways = () => { clearDriveways(); addDriveways(manifest.driveways ?? [], manifest.stubs ?? []) }
    addDrivewaysBatch = addDriveways

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
    mark('grade: lazy — nothing built at load')
    // a road knob moved: every station's half width, the asphalt, then the strip that hugs it.
    // GRASS_LIFT_M/GRASS_EDGE_M change the strip's own geometry (the turf lip and its face), which is
    // built here, so they belong in this signature too — otherwise the slider writes a value nothing
    // re-reads and nothing moves. The lip is scaled by the grass-height dials (GRASS_HEIGHT,
    // GRASS_MOWN_HEIGHT) via grassLipM(), so those have to rebuild the strip as well.
    const roadSignature = () => `${T.LANE_WIDTH}|${T.SHOULDER_OUT}|${T.SHOULDER_IN}|${T.ROAD_BLEND_M}|${T.ROAD_TAPER_M}|${T.ROAD_ONEWAY_CENTRE}|${T.CULDESAC_RADIUS}|${T.GRASS_LIFT_M}|${T.GRASS_EDGE_M}|${T.GRASS_HEIGHT}|${T.GRASS_MOWN_HEIGHT}`
    let roadSig = roadSignature()
    const plantSignature = () => `${T.TREE_CELL_M}|${T.TREE_MIN_H}|${T.TREE_HEIGHT_SCALE}|${T.TREE_DENSITY}|${T.TREE_PLANT_RADIUS_M}|${T.TREE_PATCH}|${T.TREE_SPARE_M}|${T.MOBILE_TREE_BUDGET}|${T.TREE_ROAD_CLEAR_M}`
    // Detail 0 is a display mode (cards only), not a new shape. Folding it into the signature
    // would regrow the models and rebake a washed atlas just to hide them.
    let shapeDetail = T.TREE_DETAIL > 0 ? T.TREE_DETAIL : 1
    const shapeSignature = () => {
      if (T.TREE_DETAIL > 0) shapeDetail = T.TREE_DETAIL
      return `${T.TREE_LEAF_COUNT}|${T.TREE_LEAF_SIZE}|${T.TREE_CROWN_SPREAD}|${T.TREE_BRANCH_COUNT}|${T.TREE_GNARLINESS}|${T.TREE_TAPER}|${T.TREE_TRUNK_RADIUS}|${shapeDetail}|${T.TREE_SPECIES}|${T.TREE_SPECIES_LIMIT}`
    }
    // Knobs that only change which models are seated. Lighting and colour are not in here:
    // invalidating the near set for those threw the models away and left the pale cards.
    const seatSignature = () => `${T.TREE_NEAR_RADIUS}|${T.TREE_NEAR_CAPACITY}|${T.TREE_LEAF_LOD_M}|${T.TREE_CONE_DEG}|${T.TREE_CONE_PENALTY}|${T.TREE_SIMPLE}|${T.TREE_LOLLIPOP}|${T.TREE_DETAIL <= 0 ? 0 : 1}|${T.LOD_BEHIND_PENALTY}`
    let treeSig = plantSignature()
    let treeShapeSig = shapeSignature()
    let seatSig = seatSignature()
    let treeTimer: ReturnType<typeof setTimeout> | undefined
    let roadTimer: ReturnType<typeof setTimeout> | undefined
    // async because the branch strips are budgeted: a knob change on a 427-branch network used to
    // freeze the tab for as long as the first build did
    const rebuildRoad = async () => {
      for (const arr of stGrid.values()) for (const r of arr) { if (bulbStations.includes(r as St)) continue; r.half = halfOf(r.who, r.s); r.off = r.who === 0 ? pavedOffsetAt(r.s) : 0 }
      placeBulbs()
      makeBulbs()
      makeDriveways()
      // a width change is new GEOMETRY, so the base is rebuilt rather than merely re-hidden
      buildRoads(true)
      for (const st of liveStrips) {
        road.remove(st.mesh)
        st.mesh.geometry.dispose()
      }
      liveStrips.length = 0
      gradeStats.strips = 0
      for (const u of spineUnits) u.done = false
      for (const u of branchUnits) u.done = false
      for (const r of branchRoad) { for (const o of r.base) if (o) forget(o); for (const o of r.holed) if (o) forget(o); r.base = []; r.holed = [] }
      chunkBuilt.clear()
      bridgeDone.clear()
    }
    group.add(road)
    // everything that stands on the ground near the road stands on the strip
    makeDriveways()
    const groundNear = (x: number, y: number) => gradedHeight(x, -y) ?? heightAt(x, y)
    groundAtWorld = (x, z) => gradedHeight(x, z) ?? heightAt(x, -z)
    physGroundAtOut = (x, z) => gradedHeight(x, z, true) ?? heightAt(x, -z)
    edgeDistanceWorld = (x, z) => edgeDistance(x, z).d
    // the same field, but blind to driveways: a sidewalk SHOULD cross a drive, so a rule that
    // keeps concrete off the carriageway has to ask about carriageways only
    roadInfoWorld = (x, z) => edgeDistance(x, z, undefined, true)
    roadHeightWorld = (x, z) => { const e = edgeDistance(x, z); return e.d <= T.STOPBAR_MAX_FROM_ROAD ? e.y : null }
    status('planting…')
    const treeAdj = { ...NEUTRAL_ADJ }
    // 2 m from the tiles where they are resident, the 8 m overview beyond
    const canopyOf = tileSet ? tileSet.canopyAt : pyrSet ? pyrSet.canopyAt : (x: number, y: number) => overviewCanopy(x, y)
    // where the visit starts: the level's point when we have one, else the photo station
    const photo0 = local && focus ? new THREE.Vector3(focus.x, 0, focus.z) : spineAt(photoS).pos
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    const treeBudget = lite ? 25_000 : coarse ? Math.max(400, Math.round(T.MOBILE_TREE_BUDGET)) : 120_000
    const t = treesFromCanopy(chm.data, chm.layer.size, chm.layer.bbox, chm.layer.res, heightAt, treeBudget, T.TREE_MIN_H, (x, y) => {
      if (withinPavement(x, -y, T.TREE_ROAD_CLEAR_M)) return true
      // nothing grows through a stunt fixture
      if (clearPolys.length && clearedAt(x, y)) return true
      if (!adjustments.active) return false
      const a = adjustments.at(x, y, treeAdj)
      // thin (or thicken, up to the canopy cells available) by a stable hash of position
      return a.tree_density < 1 && hash2(x, y) > a.tree_density
    }, adjustments.active ? (x, y) => adjustments.at(x, y, treeAdj).species : undefined, {
      canopyAt: (x, y) => canopyOf(x, y),
      cellM: opts.plantWhole ? Math.max(T.TREE_CELL_M, 12) : T.TREE_CELL_M,
      radius: opts.plantWhole ? 0 : T.TREE_PLANT_RADIUS_M,
      centre: [photo0.x, -photo0.z],
      // The woods you can see from the photo station. pump() fills the rest of the disc.
      // STREAM_LOCAL = 0 measures the whole disc before the first frame, as before.
      seedM: T.STREAM_LOCAL > 0 ? 280 : 0,
    })
    // a coarse grid of the trees for collision queries: cell 16 m, trunk radius from height
    const tgCell = 16
    const treeGrid = new Map<string, [number, number, number][]>()
    /**
     * Would the road-clip shader have hidden this trunk?
     *
     * `RoadCover` draws the rendered asphalt into a mask and every tree material discards the
     * fragments it covers, so a tree the planter left in the lane is invisible. The collision grid
     * did not ask, so the cars hit a trunk nobody could see — Rich, 2026-10-03, crofton-jam: held at
     * 0 km/h under full throttle on Johns Hopkins Road, the blocked body a tree capsule 2.5 m away
     * with no tree on screen. `edgeDistance` is the pavement field the mask is a photograph of; a
     * negative distance is pavement, and pavement means no collider.
     *
     * Applied to the handful a query returns, not to every record when the grid is built: the grid
     * can hold six figures, and a station walk per tree would make the replant hitch.
     */
    const trunkClipped = (x: number, z: number) => edgeDistanceWorld(x, z) < 0.5
    const indexTreeGrid = () => {
      treeGrid.clear()
      for (const r of t.records) {
        // THE COLLIDERS GO FIRST. A record inside a fixture is not indexed, so the car cannot hit
        // a trunk that is standing inside a loop even before the trees are replanted.
        if (!Number.isFinite(r.x) || r.spare) continue
        if (clearPolys.length && clearedAt(r.x, -r.z)) continue
        const k = `${Math.floor(r.x / tgCell)},${Math.floor(r.z / tgCell)}`
        const arr = treeGrid.get(k)
        const rec: [number, number, number] = [r.x, r.z, Math.max(0.25, r.h * 0.025)]
        if (arr) arr.push(rec)
        else treeGrid.set(k, [rec])
      }
    }
    indexTreeGrid()
    reindexTrees = indexTreeGrid
    treesNearWorld = (x, z, rad) => {
      const out: [number, number, number][] = []
      const cx = Math.floor(x / tgCell), cz = Math.floor(z / tgCell)
      const n = Math.ceil(rad / tgCell)
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const arr = treeGrid.get(`${cx + a},${cz + b}`)
        if (arr) for (const r of arr) if (Math.hypot(r[0] - x, r[1] - z) <= rad + r[2] && !trunkClipped(r[0], r[1])) out.push(r)
      }
      return out
    }
    trees = new THREE.Group()
    trees.name = 'trees'
    treeCount = t.count
    group.add(trees)
    // near field: real (procedural) tree models around the eye
    status('growing…')
    const near = await detail('growing: tree variants', () => new NearTrees(t.records, lite ? 140 : 240, lite ? 60 : 300, flora).grow()) // capacity here is the allocation ceiling; the live cap is the knob
    nearRef = near
    treeRecords = t.records
    treePlantingRef = () => ({ ...t.stats(), replants: replantStats.replants, lastMs: replantStats.lastMs, parts: { ...replantStats.parts } })
    trees.add(near.group)
    // grass on the verge: open ground (no canopy), off the pavement, mown near the shoulder
    // the same sampler the trees were planted from: grass rejection and the strip's forest floor
    const canopyAt = canopyOf
    canopyAtRef = canopyAt
    const grassAdj = { ...NEUTRAL_ADJ }
    // kept or rural (zoning.ts): the landuse polygon the point is in, else the nearest road's class
    const zoneAtWorld = (x: number, z: number) => {
      const lu = luIndex.zoneAt(x, -z)
      if (lu) return lu
      // carriageways only: the nearest station beside a house is its driveway, which has no class
      const e = edgeDistance(x, z, -1, true)
      if (!Number.isFinite(e.d) || e.d > 60) return null
      const hw = e.who === 0 ? segAt(e.s)?.tags?.highway : e.who >= branchWho0 ? branchAts[e.who - branchWho0]?.highway : null
      return zoneOfRoad(hw)
    }
    zoneAtOut = zoneAtWorld
    roadAtOut = (x, z) => {
      const e = edgeDistance(x, z, -1, true) // carriageways only: a driveway has no name
      if (!Number.isFinite(e.d) || e.d > 40) return null
      if (e.who === 0) {
        const seg = segAt(e.s)
        return { name: seg?.tags?.name ?? null, ref: (seg?.tags as { ref?: string } | undefined)?.ref ?? null, highway: seg?.tags?.highway ?? null, d: e.d }
      }
      // branchAts, not manifest.branches: the viewer skips branches under a metre, so the two
      // lists are not index-aligned and `who` counts the ones that were actually built
      const b = branchAts[e.who - branchWho0]
      if (b) return { name: b.name === 'branch' ? null : b.name, ref: null, highway: b.highway, d: e.d }
      return null
    }
    const tGrass = performance.now()
    const grass = new Grass(groundNear, canopyAt, grassRoadDistance, 0, look(currentSeason), lite ? 90_000 : 400_000, lite ? 26 : 40, fog, adjustments.active ? (x, y) => { const a = adjustments.at(x, y, grassAdj); return a.cover === 'crop' ? [1, 0] : [a.grass_height, a.grass_density] } : undefined, undefined, heightAt, zoneAtWorld, (x, z) => { const e = edgeDistance(x, z); return [e.gx, e.gz] }, grassBlocked)
    bootDetail.push({ phase: 'growing: grass', ms: Math.round(performance.now() - tGrass) })
    // NOT a child of `trees`. It was, and so the trees checkbox turned off all ground cover with
    // them — you could not hide the trees to look at the grass, which is most of what looking at
    // grass involves. Its own group, its own layer toggle.
    // a world bake covers everything, so the ground decides where grass grows (PLAN-OPEN-WORLD.md)
    grass.world = manifest.world === true
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
    /**
     * The crop fields OSM farmland implies. Used both for the resident rings at build and, per cell,
     * for the farmland that streams in on a tiled world (`addLanduseCell`).
     */
    const fieldsFromLanduse = (list: NonNullable<Manifest['landuse']>): CropField[] => {
      const out: CropField[] = []
      if (!(T.CROP_AUTO_FARMLAND > 0)) return out
      for (const lu of list ?? []) {
        if (lu.class !== 'farmland') continue
        const ring = lu.ring as [number, number][]
        if (ring.length < 3) continue
        const [cx, cy] = centroidOf(ring)
        // nothing in the bake says which crop; corn is the mid-Atlantic default and the editor
        // overrides it per polygon. Alternating by ring keeps a run of fields from being uniform.
        const crop: CropType = hash2(cx, cy) < 0.5 ? 'corn' : 'soy'
        out.push({ polygon: ring, crop, headingDeg: headingNear(cx, cy), spacing: 0 })
      }
      return out
    }
    if (T.CROP_AUTO_FARMLAND > 0) {
      for (const f of fieldsFromLanduse(manifest.landuse ?? [])) fields.push(f)
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
    {
      const tCrops = performance.now()
      // Crops were the single largest build cost (crofton: 43 farmland rings, 35 k rows, 6.5 s) and
      // the whole county was generated in one call. Build the fields around the visit and queue the
      // rest as grade units, like the strips and the buildings: what the car can see now, the rest
      // as it drives. `buildCrops` already splits each field into 400 m meshes, so a unit is just
      // the fields whose centre falls in that kilometre.
      const near: CropField[] = []
      const far = new Map<string, CropField[]>()
      const CELL = 1000
      for (const f of fields) {
        const [cx, cy] = centroidOf(f.polygon)
        if (!local || !focus) { near.push(f); continue }
        const dx = cx - focus.x
        const dz = -cy - focus.z
        if (dx * dx + dz * dz <= HOME_M * HOME_M) near.push(f)
        else {
          const k = `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)}`
          const arr = far.get(k)
          if (arr) arr.push(f)
          else far.set(k, [f])
        }
      }
      // One group with FLAT children: tickCrops, setCropLight and the 650 m cull all walk
      // `group.children` and would miss a nested group. Made even with no resident farmland: a
      // tiled world streams its fields in per cell, below.
      crops = buildCrops([], currentSeason, groundAtWorld, edgeDistanceWorld)
      group.add(crops.group)
      const addCropGroup = (fs: CropField[]) => {
        if (!fs.length || !crops) return
        const c = buildCrops(fs, currentSeason, groundAtWorld, edgeDistanceWorld)
        for (const ch of [...c.group.children]) crops.group.add(ch)
        for (const [k, v] of Object.entries(c.counts)) crops.counts[k] = (crops.counts[k] ?? 0) + v
      }
      addCropGroup(near)
      for (const [k, fs] of far) {
        const [cx, cy] = k.split(',').map(Number)
        gradeUnits.push({ key: `crops:${k}`, x: cx * CELL + CELL / 2, z: -(cy * CELL + CELL / 2), r: CELL * 0.75, done: false, run: () => addCropGroup(fs) })
      }
      // Farmland that arrives with a vector tile becomes its own crop unit, so a streamed cell's
      // rows are built on the pump's budget rather than inside the unit that fetched the tile.
      addLanduseCell = (list, key) => {
        const fs = fieldsFromLanduse(list)
        if (!fs.length) return
        const [cx, cy] = key.split(',').map(Number)
        gradeUnits.push({ key: `crops:${key}`, x: cx * CELL + CELL / 2, z: -(cy * CELL + CELL / 2), r: CELL * 0.75, done: false, run: () => addCropGroup(fs) })
      }
      bootDetail.push({ phase: 'growing: crops', ms: Math.round(performance.now() - tCrops) })
    }

    // --- weather -------------------------------------------------------------------------------
    const tWeather = performance.now()
    precip = new Precipitation(lite ? 18_000 : 60_000, fog)
    group.add(precip.mesh)
    precip.follow(terrainWeather)
    for (const st of liveStrips) precip.follow(st.weatherUniforms) // later ones follow as they are built
    precip.follow(grass.weatherUniforms)
    bootDetail.push({ phase: 'growing: weather', ms: Math.round(performance.now() - tWeather) })
    // what grows on this verge, read off the bake; GRASS_TYPE overrides it from the F6 panel
    const bakedGrassType = cover.grass
    grass.setType(bakedGrassType, GROUND_COVER[cover.open].blades)
    let imp: Impostors | null = null
    let reseat = () => {}
    let refreshFar = (_skip: Set<number>, _eye?: THREE.Vector3, _fwd?: THREE.Vector3, _pitch?: number) => {}
    /**
     * The budget is spent around the eye, so driving out of it has to replant. The lattice is
     * world-aligned and every jitter is a hash of the cell, so the trees that were already there
     * stay exactly where they were; what changes is which cells are in the set. Everything that
     * indexes the records — the near set's grid, the collision grid, the impostor slots — is
     * rebuilt from the same array, which is mutated in place.
     */
    const replantStats = { replants: 0, lastMs: 0, count: 0, centre: [0, 0] as [number, number], parts: { plant: 0, grid: 0, reindex: 0, reseat: 0, near: 0, far: 0 } }
    const replantTrees = (eye: THREE.Vector3, fwd?: THREE.Vector3, pitch = 0) => {
      const t0 = performance.now()
      const parts = replantStats.parts
      treeCount = t.plant(eye.x, -eye.z)
      const t1 = performance.now()
      /*
       * THE TREES THAT LEFT, NOT THE WHOLE INDEX. A plant that moved the centre frees the records
       * outside the new ring and queues the crescent; the trees that stay keep their slots. The
       * collision grid and the near set's grid used to be rebuilt from every record here — 3.0
       * and 3.3 ms over the Beltway's tens of thousands, on one frame every 350 m — when all
       * that changed is the freed slots, and the pump adds the new ones as it measures them.
       */
      const note = t.patch()
      if (note.rebuilt || note.removed.length * 2 !== note.removedAt.length) {
        indexTreeGrid()
        near.reindex()
      } else {
        for (let k = 0; k < note.removed.length; k++) {
          const x = note.removedAt[k * 2], z = note.removedAt[k * 2 + 1]
          const key = `${Math.floor(x / tgCell)},${Math.floor(z / tgCell)}`
          const arr = treeGrid.get(key)
          if (arr) {
            for (let a = arr.length - 1; a >= 0; a--) if (arr[a][0] === x && arr[a][1] === z) { arr[a] = arr[arr.length - 1]; arr.pop() }
            if (!arr.length) treeGrid.delete(key)
          }
          near.forget(note.removed[k], x, z)
        }
      }
      const t2 = performance.now()
      const t3 = t2
      reseat()
      const t4 = performance.now()
      near.update(eye, true, fwd, pitch)
      const t5 = performance.now()
      // the coarse lollipops are only in the scene when there is no renderer (no impostors);
      // writing 120k instance matrices for a mesh nobody draws is the replant's whole cost
      if (t.crowns.parent && t.crowns.visible) t.refresh(near.near)
      refreshFar(near.near, eye, fwd, pitch)
      const t6 = performance.now()
      parts.plant = t1 - t0
      parts.grid = t2 - t1
      parts.reindex = t3 - t2
      parts.reseat = t4 - t3
      parts.near = t5 - t4
      parts.far = t6 - t5
      replantStats.replants++
      replantStats.lastMs = Math.round(performance.now() - t0)
      replantStats.count = treeCount
      replantStats.centre = [+eye.x.toFixed(0), +(-eye.z).toFixed(0)]
    }
    const lastEye = new THREE.Vector3()
    forgetCanopy = () => t.forget()
    replantAt = replantTrees
    replantNow = () => replantTrees(lastEye)
    const replantIfMoved = (eye: THREE.Vector3, fwd?: THREE.Vector3, pitch = 0) => {
      lastEye.copy(eye)
      if (T.TREE_REPLANT_M > 0 && T.TREE_PLANT_RADIUS_M > 0) {
        const c = t.stats().centre
        if (Math.hypot(eye.x - c[0], -eye.z - c[1]) >= T.TREE_REPLANT_M) replantTrees(eye, fwd, pitch)
      }
      // The crescent fills a few ms a frame, and the first look walks it from the far side in.
      // A tree that lands inside the model radius or the shadow box has to be seated this frame.
      // Waiting for the 15 m gate is what left the road in cards until the car rolled forward.
      const p0 = performance.now()
      const pumped = t.pump(scaledMs(T.TREE_PLANT_BUDGET_MS))
      nearPerf.treesPump = performance.now() - p0
      nearPerf.treesPatch = 0
      if (!pumped) return
      const note = t.patch()
      const touch = (Math.max(T.TREE_NEAR_RADIUS, T.SHADOW_REACH) + 40) ** 2
      let close = false
      for (const i of note.changed) {
        near.remember(i)
        const r = t.records[i]
        if (!r || !Number.isFinite(r.x) || r.spare) continue
        const dx = r.x - eye.x, dz = r.z - eye.z
        if (dx * dx + dz * dz <= touch) close = true
        if (clearPolys.length && clearedAt(r.x, -r.z)) continue
        const k = `${Math.floor(r.x / tgCell)},${Math.floor(r.z / tgCell)}`
        const arr = treeGrid.get(k)
        const rec: [number, number, number] = [r.x, r.z, Math.max(0.25, r.h * 0.025)]
        if (arr) arr.push(rec)
        else treeGrid.set(k, [rec])
      }
      if (close) near.invalidate()
      reseat()
      nearPerf.treesPatch = performance.now() - p0 - nearPerf.treesPump
    }
    if (renderer) {
      // far field: the SAME models as impostors, one quad a tree, re-assigned as the eye moves
      status('baking impostors…')
      near.setSeason(look(currentSeason))
      imp = new Impostors(renderer, near.sources(), treeBudget, fog)
      impRef = imp
      trees.add(imp.mesh)
      shadowRef = new TreeShadowCasters(imp)
      group.add(shadowRef.group)
      const m = new THREE.Matrix4()
      // every tree gets its impostor slot ONCE (slot = tree index); the near set only toggles
      const sizes = new Float32Array(treeBudget)
      // `shown` holds the indices whose card is currently HIDDEN (the name is the original's),
      // `faded` the ones mid-dissolve. Both are a CACHE of what was written to the instance
      // buffers, kept so a near-set move writes only the slots that changed.
      let shown = new Set<number>()
      let faded = new Set<number>()
      const yawOf = (i: number) => ((i * 137) % 360) * (Math.PI / 180)
      const writeSlot = (i: number, ranged: boolean) => {
        const r = t.records[i]
        if (!r || !Number.isFinite(r.x)) return
        const v = near.variantFor(r, i)
        sizes[i] = r.h * imp!.extents[v]
        if (ranged) imp!.place(i, r.x, r.y, r.z, r.h, v, yawOf(i), m)
        else imp!.set(i, r.x, r.y, r.z, r.h, v, yawOf(i), m)
      }
      const hideSlot = (i: number) => {
        imp!.setVisible(i, false, sizes[i] || 1)
        shown.add(i)
        faded.delete(i)
      }
      const seatImpostors = () => {
        const note = t.patch()
        const usePatch = T.TREE_PATCH > 0.5 && !note.rebuilt
        if (!usePatch) {
          // a full seat rewrites every matrix. `commit` tells the upload bookkeeping so a
          // partial upload pending beside it is carried by the full one, not the other way round.
          t.records.forEach((r, i) => {
            if (!Number.isFinite(r.x)) {
              imp!.setVisible(i, false, sizes[i] || 1)
              return
            }
            writeSlot(i, false)
          })
          imp!.commit(t.records.length)
          for (const i of faded) imp!.setFade(i, 1)
          faded.clear()
          shown.clear()
          // spare trees were just written at full size; hide them. The pending full upload
          // carries the scale of zero, so they are on the GPU and not drawn.
          for (let i = 0; i < t.records.length; i++) if (t.records[i].spare) hideSlot(i)
          return
        }
        const reveal = (i: number) => {
          // a reused slot can have been hidden with its size cleared. Restoring scale 0 leaves
          // the card invisible; write the tree again before showing it.
          if (!(sizes[i] > 1e-3)) writeSlot(i, true)
          imp!.setVisible(i, true, sizes[i])
          shown.delete(i)
        }
        // spare flags alone: the matrices are already uploaded, only the scale changes. A full
        // commit here would push every card because nothing was "dirty".
        if (note.changed.length === 0 && note.removed.length === 0) {
          for (const i of note.hidden) hideSlot(i)
          for (const i of note.shown) reveal(i)
          return
        }
        const dirty = note.changed.length + note.removed.length
        const ranged = dirty > 0 && dirty <= 600
        if (ranged) {
          for (const i of note.removed) {
            imp!.setVisible(i, false, sizes[i] || 1)
            sizes[i] = 0
            shown.delete(i)
            faded.delete(i)
          }
          for (const i of note.changed) {
            writeSlot(i, true)
            shown.delete(i)
            if (t.records[i]?.spare) hideSlot(i)
          }
          for (const i of note.hidden) hideSlot(i)
          for (const i of note.shown) reveal(i)
          imp!.mesh.count = t.records.length
          return
        }
        // enough slots moved that one upload of the buffer is cheaper than hundreds of ranges.
        // Hide freed slots first, then write the new trees, so a slot that was emptied and
        // reused in the same replant is not zeroed after its new matrix was written.
        const changedSet = new Set(note.changed)
        for (const i of note.removed) {
          if (changedSet.has(i)) continue
          imp!.setVisible(i, false, sizes[i] || 1)
          sizes[i] = 0
          shown.delete(i)
          faded.delete(i)
        }
        for (const i of note.changed) writeSlot(i, false)
        imp!.commit(t.records.length)
        for (const i of note.changed) if (t.records[i]?.spare) hideSlot(i)
        for (const i of note.hidden) hideSlot(i)
        for (const i of note.shown) reveal(i)
      }
      seatImpostors()
      reseat = seatImpostors
      /*
       * THE LOLLIPOPS ARE IN THE SCENE TOO, hidden, for `TREE_LOLLIPOP`: the editor's crowns and
       * trunks, shown instead of the cards and the models when the knob is on. Their matrices are
       * written only while they are shown — `refresh` walks every tree, and writing 16k matrices
       * for a mesh nobody draws was once the whole cost of a replant.
       */
      t.crowns.visible = false
      t.trunks.visible = false
      trees.add(t.crowns, t.trunks)
      let lollyWas = false
      const lollipops = () => {
        const lolly = T.TREE_LOLLIPOP >= 0.5
        if (lolly === lollyWas) return
        lollyWas = lolly
        t.crowns.visible = lolly
        t.trunks.visible = lolly
        imp!.mesh.visible = !lolly
        if (lolly) t.refresh(new Set())
      }
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
      const lastLod = { eye: new THREE.Vector3(), fwd: null as THREE.Vector3 | null, pitch: 0 }
      refreshFar = (skip: Set<number>, eye?: THREE.Vector3, fwd?: THREE.Vector3, pitch = 0) => {
        /*
         * NO CLEARING HERE, and that was the bug (Rich, 2026-09-28: "tree impostors sometimes do
         * not disappear when real trees are drawn... refresh the page then it goes away then the
         * problem comes back").
         *
         * This runs TWICE in a frame whenever a replant fires one and the near set then moves —
         * `updateNear` calls `replantIfMoved` and then `near.update`, and both end here. Clearing
         * at the start threw away the ranges the first pass had registered, so those hides stayed
         * in the CPU array and never reached the GPU: a card left standing on the model it had
         * handed over to. A reload re-seats everything and the card goes, until it happens again.
         *
         * The ranges now accumulate and three clears them when it uploads (see uploads.ts).
         */
        if (eye) lastLod.eye.copy(eye)
        lastLod.fwd = fwd ? fwd.clone() : null
        lastLod.pitch = pitch
        const band = Math.max(0, T.TREE_FADE_M)
        // THE HANDOVER IS WHERE THE MODELS ACTUALLY STOP, not where the radius knob says.
        // `near.horizon` is the lodDistance of the farthest tree the near set managed to seat;
        // under a capacity cap that is far inside TREE_NEAR_RADIUS, and a band measured from the
        // radius then selects no one and the card simply vanishes when the model appears. Taking
        // the smaller of the two puts the dissolve exactly at the edge of the models, wherever
        // that edge happens to be this frame.
        const inner = Math.min(near.radiusNow || T.TREE_NEAR_RADIUS, near.horizon || near.radiusNow || T.TREE_NEAR_RADIUS)
        // near-set trees that should still show a dissolving card, and how solid it is
        const keep = new Map<number, number>()
        if (band > 0 && eye && fwd) {
          for (const i of skip) {
            const r = t.records[i]
            if (!r || !Number.isFinite(r.x) || r.spare) continue
            const d = T.lodDistance(r.x - eye.x, r.z - eye.z, fwd.x, fwd.z, pitch)
            if (d >= inner - band) keep.set(i, Math.min(1, Math.max(0, (d - (inner - band)) / band)))
          }
        }
        const hide = new Set<number>()
        for (const i of skip) if (!keep.has(i)) hide.add(i)
        const parked = (i: number) => {
          const r = t.records[i]
          return !r || !Number.isFinite(r.x) || r.spare === true
        }
        for (const i of shown) {
          if (hide.has(i) || parked(i)) continue
          // a reused slot can have been hidden with its size cleared. Restoring scale 0 leaves
          // the card invisible; write the tree again so turning back toward it can draw it.
          if (!(sizes[i] > 1e-3)) writeSlot(i, true)
          imp!.setVisible(i, true, sizes[i])
        }
        for (const i of hide) if (!shown.has(i)) imp!.setVisible(i, false, sizes[i])
        shown = hide
        for (const [i, f] of keep) imp!.setFade(i, f)
        for (const i of faded) if (!keep.has(i)) imp!.setFade(i, 1)
        faded = new Set(keep.keys())
      }
      // Measured from the instance matrices themselves rather than from the two sets above,
      // because the two sets above are the thing under suspicion.
      treeCardsRef = () => {
        const band = Math.max(0, T.TREE_FADE_M)
        const inner = Math.min(near.radiusNow || T.TREE_NEAR_RADIUS, near.horizon || near.radiusNow || T.TREE_NEAR_RADIUS)
        const mat = imp!.mesh.instanceMatrix.array as Float32Array
        let cards = 0
        let inBand = 0
        let doubled = 0
        for (const i of near.near) {
          const visible = mat[i * 16] > 1e-4
          const r = t.records[i]
          const f = lastLod.fwd
          const banded = band > 0 && !!f && T.lodDistance(r.x - lastLod.eye.x, r.z - lastLod.eye.z, f.x, f.z, lastLod.pitch) >= inner - band
          if (visible) cards++
          if (banded) inBand++
          if (visible && !banded) doubled++
        }
        return { nearSet: near.near.size, cards, inBand, doubled, band, replants: replantStats.replants, uploads: imp!.uploadState() }
      }
      updateNear = (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch = 0) => {
        const n0 = performance.now()
        replantIfMoved(eye, fwd, pitch)
        lollipops()
        const na = performance.now()
        const reseated = near.update(eye, false, fwd, pitch)
        const nb = performance.now()
        if (reseated) refreshFar(near.near, eye, fwd, pitch)
        const nc = performance.now()
        shadowRef?.update(near, t.records, eye, reseated, fwd)
        const n1 = performance.now()
        nearPerf.treesPlant = na - n0
        nearPerf.treesNear = nb - na
        nearPerf.treesFar = nc - nb
        nearPerf.treesShadow = n1 - nc
        grass.update(eye, fwd, pitch)
        grass.tick(time)
        const n2 = performance.now()
        if (crops) tickCrops(crops.group, time)
        precip?.tick(eye, time)
        imp!.tick()
        const n3 = performance.now()
        nearPerf.trees = n1 - n0
        nearPerf.grass = n2 - n1
        nearPerf.other = n3 - n2
      }
    } else {
      // no renderer (tests): lollipops for everything
      trees.add(t.crowns, t.trunks)
      updateNear = (eye: THREE.Vector3, time: number, fwd?: THREE.Vector3, pitch = 0) => {
        replantIfMoved(eye, fwd, pitch)
        if (near.update(eye, false, fwd, pitch)) t.refresh(near.near)
        grass.update(eye, fwd, pitch)
        grass.tick(time)
        if (crops) tickCrops(crops.group, time)
        precip?.tick(eye, time)
      }
    }
    applySurfaces = (doc) => {
      surfacesDoc = doc
      roadSets = resolveSurfaceSets(surfaceSets!, doc)
      applyTerrainFallback(roadSets)
      void rebuildRoad()
    }
    retune = () => {
      // Lighting, impostor grade and the shadow toggles are uniforms. Reseating here is what
      // rebuilt the grass and dropped the models back to pale cards on every visuals slider.
      const seat = seatSignature()
      if (seat !== seatSig) {
        seatSig = seat
        near.invalidate()
      }
      // F6 → trees. Planting knobs replant where the eye is; shape and palette knobs have to
      // regrow the ez-tree variants (~100 ms) and re-bake the impostor atlas off them, so both
      // are debounced the way the road's cross-section knobs are.
      const plantSig = plantSignature()
      const shapeSig = shapeSignature()
      if (plantSig !== treeSig || shapeSig !== treeShapeSig) {
        const replantWanted = plantSig !== treeSig
        const regrowWanted = shapeSig !== treeShapeSig
        treeSig = plantSig
        treeShapeSig = shapeSig
        clearTimeout(treeTimer)
        treeTimer = setTimeout(() => {
          void (async () => {
            if (regrowWanted) {
              await near.regrow()
              // Season BEFORE the bake: `regrow` rebuilds the variants with the full green leaf set
              // and the season's tint lives on the materials. Baking first left the atlas a summer
              // tree while the near models beside it wore autumn, and the cards never caught up
              // because only a later season change rebakes (Rich, 2026-10-05).
              near.setSeason(look(currentSeason))
              imp?.rebake(near.sources())
            }
            if (replantWanted || regrowWanted) replantTrees(lastEye)
          })()
        }, 250)
      }
      const wantType = T.GRASS_TYPE < 0 ? bakedGrassType : GRASS_TYPES[Math.min(GRASS_TYPES.length - 1, Math.max(0, Math.round(T.GRASS_TYPE)))]
      grass.setType(wantType, T.GRASS_TYPE < 0 ? GROUND_COVER[cover.open].blades : 1)
      grass.invalidate()
      if (roadSignature() !== roadSig) {
        roadSig = roadSignature()
        clearTimeout(roadTimer)
        roadTimer = setTimeout(() => {
          void rebuildRoad().then(() => {
            // a wider lane or a new taper is new pavement under standing trees: measure them again
            t.invalidateAll()
            replantNow()
          })
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
      for (const st of liveStrips) {
        st.setTint(lk.grass.base.clone().multiplyScalar(2.0).lerp(new THREE.Color(0xffffff), 0.4), imagery ? lk.ground : bare)
        st.setLitter(lk.litter.tint, lk.litter.spread)
        st.setImageryDesat(STYLE[currentStyle].desaturate)
      }
      for (const m of terrainMats) m.color.copy(m.map ? lk.ground : bare)
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
        /*
         * THE UNDERSIDE. The deck here is the road surface, and a single sheet culled its back face
         * — from a carriageway crossing below, the bridge read as a black band of sky where its
         * soffit should be. One slab spanning between the two edge beams closes it: concrete, a
         * little way below the road so the edge beams still stand proud of it. Rich, 2026-10-06.
         */
        const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (w - 0.3), 0.5, len), concrete)
        slab.position.copy(c).add(new THREE.Vector3(0, -1.35, 0))
        slab.rotation.y = yaw(dir)
        slab.userData = { structure: st }
        structures.add(slab)
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
          const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * (w2 - 0.3), 0.5, len), concrete)
          slab.position.copy(c).add(new THREE.Vector3(0, -1.35, 0))
          slab.rotation.y = yaw(dir)
          structures.add(slab)
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
      // NOT SCENERY. A "gantry" is the lidar's overhead detector finding a planar span under 5 m
      // long, 4.5 m up, and on a suburban road that is a tree limb: crofton-triangle carries four,
      // two of them 22 m apart on the main road. They were drawn as 24 m translucent cyan slabs
      // across the carriageway, which Rich read as "big blue water seams between tiles"
      // (2026-09-26). The record is still worth keeping — a real sign gantry on a motorway is in
      // the same list — so it lives with the analysis markers, visible when they are, and no
      // longer stands in the world as a piece of glass.
      const deck = st.deck_z_min ?? mid.pos.y + (st.clearance_m ?? 6)
      mesh = new THREE.Mesh(new THREE.BoxGeometry(24, 0.3, Math.max(1, st.length_m)), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.6 }))
      mesh.position.set(mid.pos.x, deck + 0.15, mid.pos.z)
      mesh.rotation.y = yaw(mid.dir)
      mesh.userData = { structure: st }
      markers.add(mesh)
      continue
    } else {
      const deck = st.deck_z_min ?? mid.pos.y + (st.clearance_m ?? 6)
      const width = pavedHalfAt((st.s_start + st.s_end) / 2) * 2
      const op = overpassMesh({ pos: mid.pos, dir: mid.dir.clone().setY(0).normalize(), s: 0 }, deck, st.length_m, width, heightAt, undefined, (x, z) => edgeDistanceWorld(x, z) < 0.5)
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
  structures.add(branchBridges)
  group.add(structures)
  group.add(markers)

  // placed assets from the editor. The streamed path builds the ones in the first kilometre
  // and queues the rest beside the roads, one cell at a time.
  status('placing…')
  const catalog = await loadCatalog()
  const inDisc = (x: number, y: number) => {
    if (!local || !focus) return true
    const dx = x - focus.x
    const dz = -y - focus.z
    return dx * dx + dz * dz <= HOME_M * HOME_M
  }
  const lineInDisc = (coords: [number, number, number?][] | undefined) =>
    !local || !focus || !coords?.length || branchTouches(coords, focus.x, focus.z, HOME_M)
  const placedItems = await loadPlacements(manifest.slug)
  const placementsGroup = await buildPlacements(
    local ? placedItems.filter((it) => inDisc(it.x, it.y)) : placedItems,
    catalog,
    groundAtWorld,
  )
  group.add(placementsGroup)
  if (local) {
    const CELL = 1000
    const buckets = new Map<string, typeof placedItems>()
    for (const it of placedItems) {
      if (inDisc(it.x, it.y)) continue
      const k = `${Math.floor(it.x / CELL)},${Math.floor(it.y / CELL)}`
      const arr = buckets.get(k)
      if (arr) arr.push(it)
      else buckets.set(k, [it])
    }
    for (const [k, items] of buckets) {
      const [cx, cy] = k.split(',').map(Number)
      gradeUnits.push({
        key: `placements:${k}`,
        x: cx * CELL + CELL / 2,
        z: -(cy * CELL + CELL / 2),
        r: CELL * 0.75,
        done: false,
        run: async () => { placementsGroup.add(await buildPlacements(items, catalog, groundAtWorld)) },
      })
    }
  }
  // the buildings the bake already knew about, as massing under whatever the catalogue places
  status('raising buildings…')
  // per 500 m cell, built around the eye like the strips (a cell after the strips that cross it,
  // by distance order: the strips' units carry a larger radius). `built` keeps the shape the rest
  // of the file and the probes expect; its stats accumulate as cells arrive.
  const buildingsGroup = new THREE.Group()
  buildingsGroup.name = 'buildings'
  const builtParts: { recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => void }[] = []
  let palette: { walls: [number, number, number][]; roofs: [number, number, number][] } | null = null
  const built = {
    group: buildingsGroup,
    stats: { count: 0, gabled: 0, fromLidar: 0, dressed: 0 },
    recolour: (walls: [number, number, number][], roofs: [number, number, number][]) => {
      palette = { walls, roofs }
      for (const p of builtParts) p.recolour(walls, roofs)
    },
  }
  // Cut-face and outcrop rock streams with the cell that owns it. `buildRocks` is pure — it makes a
  // group and reads only the cut/rock arrays it is handed — so a cell can build its own with no
  // global state, and a world with no tiles builds the lot in one call below. The group and the
  // running counts are the same objects the rest of the file already reads (`layers.rocks`,
  // `rockCounts`), so nothing downstream knows the difference.
  const rocksGroup = new THREE.Group()
  rocksGroup.name = 'rocks'
  const rocksParts: RocksResult[] = []
  const rocksBuilt = new Set<string>()
  const buildRocksInto = async (cuts: Manifest['cuts'], rock: Manifest['rock']) => {
    const r = await buildRocks(cuts, rock, catalog, groundAtWorld, edgeDistanceWorld)
    if (r.faces || r.polygons || Object.keys(r.counts).length) {
      rocksGroup.add(r.group)
      rocksParts.push(r)
    }
  }
  const addRocksCell = (key: string, cuts: Manifest['cuts'], rock: Manifest['rock']) => {
    if (rocksBuilt.has(key)) return
    if (!(cuts?.faces?.length) && !(rock?.polygons?.length)) return
    rocksBuilt.add(key)
    void buildRocksInto(cuts, rock)
  }
  const rocks: RocksResult = {
    group: rocksGroup,
    get counts() {
      const out: Record<string, number> = {}
      for (const r of rocksParts) for (const [k, v] of Object.entries(r.counts)) out[k] = (out[k] ?? 0) + v
      return out
    },
    get faces() { return rocksParts.reduce((s, r) => s + r.faces, 0) },
    get polygons() { return rocksParts.reduce((s, r) => s + r.polygons, 0) },
  }
  // Water streams the same way (`add` in water.ts). Held here, before `buildWater`, so a cell's
  // channels can be handed over from `hydrateCell`; the home furniture cells hydrate synchronously
  // during this build (before the builder exists), so their water waits in `pendingWater` and is
  // drained the moment the builder is ready. An untiled world arrives whole in the call below.
  let waterStream: ReturnType<typeof buildWater> | null = null
  const pendingWater: NonNullable<Manifest['water']>[] = []
  // A tiled world streams its roads with its vector tiles. The index starts as the spine and grows
  // as each tile arrives; the running manifest arrays (`siblings`, `driveways`, `stubs`) grow with
  // it, so the once-only readers (the minimap, the editor) still see what is loaded. `addDriveways`
  // lays each tile's ribbons as it comes. Idempotent per cell, because the building pump and the
  // furniture pump both fetch the same tile (`loadVectorTile` caches it).
  const roads = buildRoadIndex(manifest)
  const hydrated = new Set<string>()
  const hydrateCell = async (key: string, files: Record<string, unknown>, budget?: Budget) => {
    if (!manifest.vt?.cells?.length || hydrated.has(key)) return
    hydrated.add(key)
    await budget?.tick()
    relieveCell(files)
    await budget?.tick()
    const sibs = (files.siblings ?? []) as NonNullable<Manifest['siblings']>
    const dws = (files.driveways ?? []) as NonNullable<Manifest['driveways']>
    const sts = (files.stubs ?? []) as NonNullable<Manifest['stubs']>
    // cut faces and outcrops arrive with the cell; `relieveCell` above already lifted them
    addRocksCell(key, files.cuts as Manifest['cuts'], files.rock as Manifest['rock'])
    await budget?.tick()
    // channels too; `_load_tiled` wrote `water` as `{lines, areas}` and `relieveCell` lifted them
    const w = files.water as Manifest['water'] | undefined
    if (w) { if (waterStream) waterStream.add(w); else pendingWater.push(w) }
    // land use: feed the zoning index now and queue this cell's farmland for the crop builder. Keep
    // `manifest.landuse` a running view of what is loaded, as with buildings, for the editor.
    const lu = files.landuse as NonNullable<Manifest['landuse']> | undefined
    if (lu?.length) {
      luIndex.add(lu)
      ;(manifest.landuse ??= []).push(...lu)
      addLanduseCell?.(lu, key)
    }
    // points of interest: no viewer reader needs them live, but the editor's autogen does, so keep a
    // running view of what is loaded, as with buildings.
    const pois = files.pois as NonNullable<Manifest['pois']> | undefined
    if (pois?.length) (manifest.pois ??= []).push(...pois)
    for (const s of sibs) { (manifest.siblings ??= []).push(s); roads.addLine(s) }
    for (const d of dws) { (manifest.driveways ??= []).push(d); roads.addLine(d.coords) }
    for (const st of sts) { (manifest.stubs ??= []).push(st); roads.addLine(st.coords) }
    await budget?.tick()
    addDrivewaysBatch(dws, sts)
    // junction facts, so a branch that meets here learns who has priority even though it was taken
    // before this tile arrived (the meet re-runs when branches stream — see the branch pump)
    const ixs = (files.intersections as Manifest['intersections'] | undefined)?.list ?? []
    for (const x of ixs) for (const n of x.nodes ?? []) xByNode.set(n, x)
  }
  {
    // one index for the whole site, not one per cell: the cells slice the BUILDINGS, and a house
    // in the last cell still needs to know about the road in the first
    const build = async (list: NonNullable<Manifest['buildings']>, cx: number, cy: number, budget: Budget) => {
      const b = await buildBuildings({ ...manifest, buildings: list }, groundAtWorld, T.STREAM_BUDGET_MS, { roads, pool: poolOf(surfacesDoc), budget })
      b.group.userData.enuX = cx
      b.group.userData.enuY = cy
      buildingsGroup.add(b.group)
      builtParts.push(b)
      if (palette) b.recolour(palette.walls, palette.roofs)
      built.stats.count += b.stats.count
      built.stats.gabled += b.stats.gabled
      built.stats.fromLidar += b.stats.fromLidar
      built.stats.dressed += b.stats.dressed
      gradeStats.buildings += b.stats.count
    }
    if (manifest.vt?.buildings?.length) {
      // A tiled world: one unit per 1 km vector tile, fetched when the pump reaches it. The manifest
      // no longer carries the footprints, and load no longer buckets them all — see export._vector_tiles.
      const size = manifest.vt.size_m || 1000
      const dir = manifest.vt.dir
      console.info(`[boot] ${manifest.slug}: ${manifest.vt.buildings.length} building tiles, ${manifest.vt.count ?? '?'} footprints — streamed, not resident`)
      for (const t of manifest.vt.buildings) {
        const cx = t.x * size + size / 2
        const cy = t.y * size + size / 2
        gradeUnits.push({ key: `buildings:${t.x},${t.y}`, x: cx, z: -cy, r: size * 0.71 + 10, done: false, run: async (budget) => {
          const files = await loadVectorTile(manifest.slug, dir, t.x, t.y)
          await hydrateCell(`${t.x},${t.y}`, files, budget)
          const list = (files.buildings ?? []) as NonNullable<Manifest['buildings']>
          if (!list.length) return
          // keep `manifest.buildings` a running view of what is loaded, so physics/attribution and
          // the editor see the near-eye footprints without a second pass
          ;(manifest.buildings ??= []).push(...list)
          await build(list, cx, cy, budget)
        } })
      }
    } else {
      const CELL = 500
      const cells = new Map<string, NonNullable<Manifest['buildings']>>()
      for (const bd of manifest.buildings ?? []) {
        const p0 = bd.ring?.[0]
        if (!p0) continue
        const k = `${Math.floor(p0[0] / CELL)},${Math.floor(p0[1] / CELL)}`
        const arr = cells.get(k)
        if (arr) arr.push(bd)
        else cells.set(k, [bd])
      }
      for (const [k, list] of cells) {
        const [cx, cy] = k.split(',').map(Number)
        gradeUnits.push({ key: `buildings:${k}`, x: cx * CELL + CELL / 2, z: -(cy * CELL + CELL / 2), r: CELL * 0.71 + 10, done: false, run: (budget) => build(list, cx * CELL + CELL / 2, cy * CELL + CELL / 2, budget) })
      }
    }
  }
  group.add(built.group)
  // Poles, signs, lots, walks and the junction paint. The streamed path does the kilometre
  // around the start now; each other kilometre is a unit the pump runs when the car reaches it,
  // parented under the same layer groups so a toggle still hides the late ones.
  const roadSurfaceAt = (x: number, z: number): number | null => {
    const y = roadHeightWorld(x, z)
    return y === null ? null : y + 0.02
  }
  status('junction facts…')
  const facts = await loadJunctionFacts(manifest.slug, `${DATA_BASE}/sites`)
  mark('street furniture…')
  const proj = manifest.frame ? siteProjector(manifest.frame as Parameters<typeof siteProjector>[0]) : null
  const crossingNodes = proj ? facts.crossings.map((c) => { const [x, y] = proj(c.lon, c.lat); return { x, y, marked: c.marked } }) : []
  const streetSlice = (home: boolean): Manifest => {
    if (!local || !focus) return manifest
    const keep = (x: number, y: number) => inDisc(x, y) === home
    const sig = manifest.signals
    const ix = manifest.intersections
    return {
      ...manifest,
      signals: sig ? {
        masts: sig.masts.filter((p) => keep(p.x, p.y)),
        signs: sig.signs.filter((p) => keep(p.x, p.y)),
        bars: (sig.bars ?? []).filter((p) => keep(p.x, p.y)),
      } : sig,
      parking: (manifest.parking ?? []).filter((p) => (p.ring[0] ? keep(p.ring[0][0], p.ring[0][1]) : false)),
      barriers: (manifest.barriers ?? []).filter((b) => lineInDisc(b.coords) === home),
      sidewalks: (manifest.sidewalks ?? []).filter((b) => lineInDisc(b.coords) === home),
      driveways: (manifest.driveways ?? []).filter((d) => lineInDisc(d.coords) === home),
      power: manifest.power ? {
        lines: manifest.power.lines.filter((l) => lineInDisc(l.coords) === home),
        supports: manifest.power.supports.filter((s) => keep(s.x, s.y)),
      } : null,
      intersections: ix ? { ...ix, list: ix.list.filter((n) => keep(n.x, n.y) || n.corners.some((c) => keep(c.x, c.y))) } : ix,
    }
  }
  // A branch-segment grid, built ONCE, so an OSM crossing node only tests the few segments near it
  // instead of every branch vertex on the site. The old scan was ~2e10 ops on dc-metro and showed
  // up as 244 s of "street: crosswalks" at load — and again for every far cell the pump reached.
  const SEG_M = 250
  type Seg = { ax: number; ay: number; dx: number; dy: number; l2: number }
  const segGrid = new Map<number, Seg[]>()
  const indexedBranchSegs = new Set<string>()
  const addBranchSegments = (b: NonNullable<Manifest['branches']>[number]) => {
    const c = b.coords
    if (!c) return
    // A way is now in every tile it crosses, so the pump meets the same branch more than once.
    // Index its segments once — same key `takeBranch` dedupes on.
    const c0 = c[0]
    const key = b.id ?? `${c0?.[0]},${c0?.[1]},${c.length},${b.name ?? ''}`
    if (indexedBranchSegs.has(key)) return
    indexedBranchSegs.add(key)
    for (let k = 1; k < c.length; k++) {
      const ax = c[k - 1][0], ay = c[k - 1][1], bx = c[k][0], by = c[k][1]
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1
      const gx0 = Math.floor(Math.min(ax, bx) / SEG_M), gx1 = Math.floor(Math.max(ax, bx) / SEG_M)
      const gy0 = Math.floor(Math.min(ay, by) / SEG_M), gy1 = Math.floor(Math.max(ay, by) / SEG_M)
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const kk = gx * 100000 + gy
        const seg: Seg = { ax, ay, dx, dy, l2 }
        const arr = segGrid.get(kk)
        if (arr) arr.push(seg)
        else segGrid.set(kk, [seg])
      }
    }
  }
  // A tiled world's far branches arrive later and add their own segments (`indexBranchSegment`); the
  // ones taken at load (home) are already in `branchRaw`. An untiled world is complete in `branches`.
  indexBranchSegment = addBranchSegments
  if (branchTiled) { for (const b of branchRaw) addBranchSegments(b.br) }
  else { for (const b of manifest.branches ?? []) addBranchSegments(b) }
  const nearestBranchDir = (x: number, y: number): THREE.Vector3 | null => {
    const gx = Math.floor(x / SEG_M), gy = Math.floor(y / SEG_M)
    let best = Infinity, dir: THREE.Vector3 | null = null
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      const arr = segGrid.get(ix * 100000 + iy)
      if (!arr) continue
      for (const s of arr) {
        const t = Math.max(0, Math.min(1, ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / s.l2))
        const d = Math.hypot(s.ax + t * s.dx - x, s.ay + t * s.dy - y)
        if (d < best) { best = d; dir = new THREE.Vector3(s.dx, 0, -s.dy).normalize() }
      }
    }
    return best <= 15 ? dir : null
  }
  const wetExtra: THREE.Object3D[] = []
  let streetRoot: {
    power: Awaited<ReturnType<typeof buildPower>>
    furniture: Awaited<ReturnType<typeof buildFurniture>>
    parking: Awaited<ReturnType<typeof buildParking>>
    barriers: Awaited<ReturnType<typeof buildBarriers>>
    sidewalks: Awaited<ReturnType<typeof buildSidewalks>>
    signals: Awaited<ReturnType<typeof buildSignals>>
    stopbars: Awaited<ReturnType<typeof buildStopBars>>
    blades: Awaited<ReturnType<typeof buildBlades>>
    crosswalks: Awaited<ReturnType<typeof buildCrosswalks>>
    arrows: Awaited<ReturnType<typeof buildLaneArrows>>
  } | null = null
  /**
   * One cell's street furniture, on the pump's budget.
   *
   * This whole path used to run synchronously inside the `loadVectorTile` continuation, so a tile
   * arriving while the car was moving was one long task — measured at 1.5–2.1 s through the dev
   * bridge, with input dead and no paint. It was never GC and never the budgeted builders: the
   * per-tile walks (180 ms), masts and crosswalks simply had no `Budget`. Now every builder that
   * can be long takes the budget as a bare yield and the whole cell is interruptible, like the
   * building and strip units it sits beside.
   */
  const addStreet = async (m: Manifest, xnodes: typeof crossingNodes, budget: Budget) => {
    const first = !streetRoot
    const yieldFn = () => budget.tick()
    const wrap = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      if (!first) return fn()
      const t0 = performance.now()
      const r = await fn()
      bootDetail.push({ phase: name, ms: Math.round(performance.now() - t0) })
      return r
    }
    const powerG = await wrap('street: power', () => buildPower(m, groundAtWorld))
    const furnitureG = await wrap('street: furniture', () => buildFurniture(m, groundAtWorld, edgeDistanceWorld, yieldFn))
    const parkingG = await wrap('street: parking', () => buildParking(m, groundAtWorld, edgeDistanceWorld, surfaceSets ?? {}))
    const barriersG = await wrap('street: barriers', () => buildBarriers(m, groundAtWorld))
    const sidewalksG = await wrap('street: sidewalks', () => buildSidewalks(m, groundAtWorld, edgeDistanceWorld, roadInfoWorld, yieldFn))
    const signalsG = await wrap('street: signals', () => buildSignals(m, furnitureG.placed))
    const stopbarsG = await wrap('street: stopbars', () => buildStopBars(m, roadSurfaceAt, edgeDistanceWorld, facts.lanes))
    const crosswalksG = await wrap('street: crosswalks', () => buildCrosswalks(m, roadSurfaceAt, edgeDistanceWorld, sidewalkCover(m, 1.0), xnodes, nearestBranchDir, yieldFn))
    const arrowsG = await wrap('street: arrows', () => buildLaneArrows(m, roadSurfaceAt, facts.lanes))
    stopbarsG.group.add(crosswalksG.group)
    stopbarsG.group.add(arrowsG.group)
    const bladesG = await wrap('street: blades', () => buildBlades(m, groundAtWorld, edgeDistanceWorld))
    signalTicks.push(signalsG.tick)
    if (!streetRoot) {
      streetRoot = {
        power: powerG, furniture: furnitureG, parking: parkingG, barriers: barriersG, sidewalks: sidewalksG,
        signals: signalsG, stopbars: stopbarsG, blades: bladesG, crosswalks: crosswalksG, arrows: arrowsG,
      }
      group.add(powerG.group, furnitureG.group, parkingG.group, barriersG.group, sidewalksG.group, signalsG.group, stopbarsG.group, bladesG.group)
    } else {
      streetRoot.power.group.add(powerG.group)
      streetRoot.furniture.group.add(furnitureG.group)
      streetRoot.parking.group.add(parkingG.group)
      streetRoot.barriers.group.add(barriersG.group)
      streetRoot.sidewalks.group.add(sidewalksG.group)
      streetRoot.signals.group.add(signalsG.group)
      streetRoot.stopbars.group.add(stopbarsG.group)
      streetRoot.blades.group.add(bladesG.group)
    }
    wetExtra.push(parkingG.group, sidewalksG.group)
  }
  // --- street furniture: where a cell's comes from ---------------------------------------------
  // `sidewalks`, `parking`, `barriers`, `power` and `signals` are consumed only by the builders
  // `addStreet` runs, so a tiled bake moves them into the per-1 km vector tiles (`vt.cells`) and the
  // viewer fetches a cell's furniture when the pump reaches it — no longer 100 MB resident for one
  // disc. `driveways` and `intersections` stay inline: `makeDriveways` lays every driveway as a
  // road-group ribbon at load, and junction paint (`junctionPaintCut`) and the junction-meet pass
  // (`xByNode`) need the whole intersection list. They are bucketed here — once — and merged with
  // the tile, so a far cell still gets the driveways and junctions that fall in it.
  const CELL = 1000
  type Bucket = { masts: NonNullable<Manifest['signals']>['masts']; signs: NonNullable<Manifest['signals']>['signs']; bars: NonNullable<NonNullable<Manifest['signals']>['bars']>; parking: NonNullable<Manifest['parking']>; barriers: NonNullable<Manifest['barriers']>; sidewalks: NonNullable<Manifest['sidewalks']>; driveways: NonNullable<Manifest['driveways']>; lines: NonNullable<Manifest['power']>['lines']; supports: NonNullable<Manifest['power']>['supports']; intersections: NonNullable<Manifest['intersections']>['list'] }
  const buckets = new Map<string, Bucket>()
  const bucket = (x: number, y: number): Bucket => {
    const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
    let b = buckets.get(k)
    if (!b) {
      b = { masts: [], signs: [], bars: [], parking: [], barriers: [], sidewalks: [], driveways: [], lines: [], supports: [], intersections: [] }
      buckets.set(k, b)
    }
    return b
  }
  const tiledFurniture = manifest.vt?.cells?.length ? manifest.vt : null
  const tiledCells = tiledFurniture?.cells ?? []
  if ((local && focus) || tiledFurniture) {
    // Tiled: every cell owns its inline driveways/junctions, home included, so bucket the whole
    // array. Inline: only the far half is bucketed; the home disc is built eagerly below.
    const spread = tiledFurniture ? manifest : streetSlice(false)
    for (const p of spread.signals?.masts ?? []) bucket(p.x, p.y).masts.push(p)
    for (const p of spread.signals?.signs ?? []) bucket(p.x, p.y).signs.push(p)
    for (const p of spread.signals?.bars ?? []) bucket(p.x, p.y).bars.push(p)
    for (const p of spread.parking ?? []) { const q = p.ring[0]; if (q) bucket(q[0], q[1]).parking.push(p) }
    for (const p of spread.barriers ?? []) { const q = p.coords[0]; if (q) bucket(q[0], q[1]).barriers.push(p) }
    for (const p of spread.sidewalks ?? []) { const q = p.coords[0]; if (q) bucket(q[0], q[1]).sidewalks.push(p) }
    for (const p of spread.driveways ?? []) { const q = p.coords[0]; if (q) bucket(q[0], q[1]).driveways.push(p) }
    for (const p of spread.power?.lines ?? []) { const q = p.coords[0]; if (q) bucket(q[0], q[1]).lines.push(p) }
    for (const p of spread.power?.supports ?? []) bucket(p.x, p.y).supports.push(p)
    for (const p of spread.intersections?.list ?? []) bucket(p.x, p.y).intersections.push(p)
  }
  // Crossing nodes are bucketed on the same 1 km grid, so a cell only tests the crossings in its own
  // cell rather than all 20k — half of the "street: crosswalks" freeze before the nearestDir fix.
  const crossingsByCell = new Map<string, typeof crossingNodes>()
  for (const n of crossingNodes) {
    const k = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`
    const a = crossingsByCell.get(k)
    if (a) a.push(n)
    else crossingsByCell.set(k, [n])
  }
  /** A cell's Manifest: the bucket's inline arrays, a tiled bake's arrays fetched over the top (a
   *  tiled bake ships the bucket's copies empty, so the tile is their only source). */
  const cellManifest = (k: string, tiled: Record<string, unknown> | null): Manifest => {
    const b = buckets.get(k)
    return {
      ...manifest,
      signals: (tiled?.signals as Manifest['signals']) ?? { masts: b?.masts ?? [], signs: b?.signs ?? [], bars: b?.bars ?? [] },
      parking: (tiled?.parking as Manifest['parking']) ?? b?.parking ?? [],
      barriers: (tiled?.barriers as Manifest['barriers']) ?? b?.barriers ?? [],
      sidewalks: (tiled?.sidewalks as Manifest['sidewalks']) ?? b?.sidewalks ?? [],
      power: (tiled?.power as Manifest['power']) ?? (manifest.power ? { lines: b?.lines ?? [], supports: b?.supports ?? [] } : null),
      driveways: (tiled?.driveways as Manifest['driveways']) ?? b?.driveways ?? [],
      intersections: (tiled?.intersections as Manifest['intersections']) ?? (manifest.intersections ? { ...manifest.intersections, list: b?.intersections ?? [] } : null),
    }
  }
  const builtStreet = new Set<string>()
  const buildStreetCell = async (cx: number, cy: number, tiled: Record<string, unknown> | null, budget: Budget) => {
    const k = `${cx},${cy}`
    if (builtStreet.has(k)) return
    builtStreet.add(k)
    await addStreet(cellManifest(k, tiled), crossingsByCell.get(k) ?? [], budget)
  }
  if (tiledFurniture) {
    const size = tiledFurniture.size_m || CELL
    const dir = tiledFurniture.dir
    const fc = tiledFurniture.counts
    console.info(`[boot] ${manifest.slug}: ${tiledCells.length} furniture tiles${fc ? ` (${fc.sidewalks ?? 0} walks, ${fc.masts ?? 0} masts, ${fc.parking ?? 0} lots)` : ''} — streamed, not resident`)
    // The home tiles NOW, so `streetRoot` exists for everything below; the rest through the pump,
    // nearest first, exactly as the building tiles are. The home disc spans at most a 2x2 of tiles.
    const home = local && focus
      ? { x0: Math.floor((focus.x - HOME_M) / size), x1: Math.floor((focus.x + HOME_M) / size), y0: Math.floor((-focus.z - HOME_M) / size), y1: Math.floor((-focus.z + HOME_M) / size) }
      : { x0: tiledCells[0].x, x1: tiledCells[0].x, y0: tiledCells[0].y, y1: tiledCells[0].y }
    const homeStreetBudget = new Budget(T.STREAM_BUDGET_MS)
    for (let cx = home.x0; cx <= home.x1; cx++) for (let cy = home.y0; cy <= home.y1; cy++) {
      const files = await loadVectorTile(manifest.slug, dir, cx, cy)
      await hydrateCell(`${cx},${cy}`, files, homeStreetBudget)
      await buildStreetCell(cx, cy, files, homeStreetBudget)
    }
    for (const c of tiledCells) {
      const k = `${c.x},${c.y}`
      if (builtStreet.has(k)) continue
      gradeUnits.push({ key: `street:${k}`, x: c.x * size + size / 2, z: -(c.y * size + size / 2), r: size * 0.75, done: false, run: async (budget) => {
        const files = await loadVectorTile(manifest.slug, dir, c.x, c.y)
        await hydrateCell(k, files, budget)
        await buildStreetCell(c.x, c.y, files, budget)
      } })
    }
  } else {
    await addStreet(local ? streetSlice(true) : manifest, local ? crossingNodes.filter((n) => inDisc(n.x, n.y)) : crossingNodes, new Budget(T.STREAM_BUDGET_MS))
    if (local && focus) {
      for (const [k] of buckets) {
        const [cx, cy] = k.split(',').map(Number)
        gradeUnits.push({ key: `street:${k}`, x: cx * CELL + CELL / 2, z: -(cy * CELL + CELL / 2), r: CELL * 0.75, done: false, run: async (budget) => { await buildStreetCell(cx, cy, null, budget) } })
      }
    }
  }
  const power = streetRoot!.power
  const furniture = streetRoot!.furniture
  const parking = streetRoot!.parking
  const barriers = streetRoot!.barriers
  const sidewalks = streetRoot!.sidewalks
  const signals = streetRoot!.signals
  const stopbars = streetRoot!.stopbars
  const blades = streetRoot!.blades
  const crosswalks = streetRoot!.crosswalks
  const arrows = streetRoot!.arrows
  const registerWet = () => {
    canBeWet(road)
    for (const g of wetExtra) canBeWet(g)
    for (const s of Object.values(surfaceSets ?? {})) canBeWet(new THREE.Mesh(undefined, s.material))
  }
  registerWet()
  mark('furniture: signs, masts, lots, barriers, walks, signals, stop bars, blades')
  structures.add(await buildBridges(overrides, catalog, spineAt, groundAtWorld, (s) => pavedHalfAt(s) * 2))
  mark('furniture: bridges')

  // terrain features (terrain-and-data agent): rock on the measured cut faces and outcrops, water in
  // the measured channels. Both stand on groundAt; the water's ripples tick with the near update.
  status('dressing…')
  // A tiled world's rock was built per cell as each arrived (see `addRocksCell`). An untiled world,
  // or one tiled before rock streamed, still carries the arrays in the manifest — build those here,
  // keyed on the data rather than the tile index so either schema draws.
  if (manifest.cuts?.faces?.length || manifest.rock?.polygons?.length) {
    await buildRocksInto(manifest.cuts, manifest.rock)
  }
  group.add(rocks.group)
  const water = buildWater(manifest.water, groundAtWorld, lowestGround)
  waterStream = water
  for (const w of pendingWater) water.add(w)
  pendingWater.length = 0
  /**
   * A style is the season re-applied (trees, grass, strips, terrain, horizon and impostors all
   * read the styled look), plus the four things a season never touched: the photo's
   * desaturation, the building palettes, the water, and the road paint.
   */
  const setStyle = (style: Style) => {
    currentStyle = style
    const def = STYLE[style]
    setSeason(currentSeason)
    terrainDesat.value = def.desaturate
    built.recolour(def.walls, def.roofs)
    water.setColours(def.water.stream, def.water.still, def.water.sea, def.water.opacityBias)
    water.setLook(def.water.look ?? null)
    paintNow = { centre: def.paint.centre, edge: def.paint.edge }
    repaintMarkings(road, def.paint.centre, def.paint.edge)
  }
  if (initialStyle !== 'realistic') setStyle(initialStyle)
  group.add(water.group)
  {
    const inner = updateNear
    let canopyLevel = -2
    // the per-road / per-block visibility pass below is 1.1 ms a frame over the DC Beltway's
    // children (2026-10-08); it only has an answer to change when the level under the eye does,
    // the eye has moved a way, or tiles have had time to land — so that is when it runs
    const lodPass = { here: -99 as number | null, x: NaN, z: NaN, frame: 0 }
    let lodFrame = 0
    updateNear = (eye, time, fwd, pitch) => {
      const m0 = performance.now()
      roadCover?.refresh(road, eye)
      const m1 = performance.now()
      inner(eye, time, fwd, pitch)
      const m2 = performance.now()
      water.tick(time, eye, fwd)
      const m3 = performance.now()
      stream?.update(eye.x, -eye.z) // site frame: y = -z
      const m4 = performance.now()
      const ground = heightAt(eye.x, -eye.z)
      const agl = Number.isFinite(ground) ? Math.max(0, eye.y - ground) : 0
      pyr?.update(eye.x, -eye.z, false, fwd ? { agl, fx: fwd.x, fy: fwd.y, fz: fwd.z } : { agl, fx: 0, fy: -1, fz: 0 })
      const m5 = performance.now()
      // Roads, houses, trees and grass leave with the coarse tiles. Houses are one group per
      // block, so a z10 patch drops its own. A long road follows the tile under the camera.
      if (pyrSet) {
        // A leaf that is wanted but still loading must not blank the road: the parent is what
        // is resident for that moment, and it is the same ground the leaf is about to replace.
        const zAt = (x: number, north: number) => {
          const resident = pyrSet.levelAt(x, north)
          const wanted = pyr?.wantedZ(x, north) ?? null
          if (resident == null) return wanted
          if (wanted == null) return resident
          return Math.max(resident, wanted)
        }
        const here = zAt(eye.x, -eye.z)
        const layerOn = (obj: THREE.Object3D) => {
          if (obj.userData.layerOn === undefined) obj.userData.layerOn = obj.visible
          return !!obj.userData.layerOn
        }
        const show = (obj: THREE.Object3D | null | undefined, minZ: number) => {
          if (!obj) return
          obj.visible = layerOn(obj) && (minZ <= 0 || here == null || here >= minZ)
        }
        show(trees, T.PYR_TREE_Z)
        show(grassRef?.mesh, T.PYR_GRASS_Z)
        road.visible = layerOn(road)
        built.group.visible = layerOn(built.group)
        lodFrame++
        const due = here !== lodPass.here || !(Math.hypot(eye.x - lodPass.x, eye.z - lodPass.z) < 40) || lodFrame - lodPass.frame >= 20
        if (due) {
        lodPass.here = here
        lodPass.x = eye.x
        lodPass.z = eye.z
        lodPass.frame = lodFrame
        if (T.PYR_ROAD_Z <= 0 || here == null) {
          for (const c of road.children) c.visible = true
        } else {
          for (const c of road.children) {
            const n = c.children.length
            if (c.userData.lodN !== n) { c.userData.lodN = n; c.userData.lodCover = undefined }
            let cover = c.userData.lodCover as { x: number; north: number; wide: boolean } | undefined
            if (!cover) {
              const bounds = new THREE.Box3().setFromObject(c)
              if (bounds.isEmpty()) { c.visible = true; continue }
              const center = bounds.getCenter(new THREE.Vector3())
              const size = bounds.getSize(new THREE.Vector3())
              cover = { x: center.x, north: -center.z, wide: Math.hypot(size.x, size.z) > 700 }
              c.userData.lodCover = cover
            }
            const z = cover.wide ? here : zAt(cover.x, cover.north)
            c.visible = z == null || z >= T.PYR_ROAD_Z
          }
        }
        if (T.PYR_HOUSE_Z <= 0) {
          for (const c of built.group.children) c.visible = true
        } else {
          for (const c of built.group.children) {
            const x = c.userData.enuX as number | undefined
            const y = c.userData.enuY as number | undefined
            if (x === undefined || y === undefined) { c.visible = true; continue }
            const z = zAt(x, y)
            c.visible = z == null || z >= T.PYR_HOUSE_Z
          }
        }
        }
      }
      // The overview mesh is the ground before a tile covers the camera. Once one does, drawing
      // both shades the same neighbourhood twice, which is most of the fill rate.
      overview.visible = !(pyrSet && pyrSet.covers(eye.x, -eye.z))
      // After the pump is idle, so a normal pass never reads the overview while a strip is sinking it.
      if (overview.visible && overviewNormalsDirty && !gradePumping) void refreshOverviewNormals()
      // Crop rows are full detail, and a county of them is in the frustum from anywhere in it.
      // Past this the photograph already shows the field.
      if (crops) {
        const keep = 650
        for (const ch of crops.group.children) {
          const mesh = ch as THREE.Mesh
          const sphere = mesh.geometry.boundingSphere
          if (!sphere) continue
          mesh.visible = Math.hypot(sphere.center.x - eye.x, sphere.center.z - eye.z) - sphere.radius < keep
        }
      }
      if (pyrSet) {
        const lvl = pyrSet.levelAt(eye.x, -eye.z) ?? -1
        if (lvl !== canopyLevel) {
          canopyLevel = lvl
          forgetCanopy()
          replantAt(eye, fwd, pitch ?? 0)
        }
      }
      const m6 = performance.now()
      for (const tick of signalTicks) tick(time)
      gradeNear(eye)
      const m7 = performance.now()
      veg?.update(eye.x, -eye.z)
      const m8 = performance.now()
      nearPerf.roadCover = m1 - m0
      nearPerf.water = m3 - m2
      nearPerf.stream = m4 - m3
      nearPerf.pyr = m5 - m4
      nearPerf.lod = m6 - m5
      nearPerf.grade = m7 - m6
      nearPerf.veg = m8 - m7
      nearPerf.total = m8 - m0
    }
  }

  mark('done')
  const bootMs = buildProfile.reduce((s, p) => s + p.ms, 0)
  const bootSlow = buildProfile.filter((p) => p.ms >= 50).sort((a, b) => b.ms - a.ms)
  console.info(`[boot] ${manifest.slug} build ${bootMs} ms`, bootSlow.map((p) => `${p.phase.replace(/…$/, '')} ${p.ms}`).join(' · '))
  const detailSlow = bootDetail.filter((p) => p.ms >= 5).sort((a, b) => b.ms - a.ms)
  if (detailSlow.length) console.info(`[boot:detail] ${manifest.slug}`, detailSlow.map((p) => `${p.phase} ${p.ms}`).join(' · '))

  return {
    manifest,
    group,
    layers: { imagery: terrain, trees, grass: grassRef?.mesh, crops: crops?.group, road, horizon, structures, spine, markers, placements: placementsGroup, buildings: built.group, power: power.group, furniture: furniture.group, parking: parking.group, barriers: barriers.group, sidewalks: sidewalks.group, rocks: rocks.group, water: water.group, signals: signals.group, stopbars: stopbars.group, blades: blades.group },
    buildingStats: built.stats,
    adjustments,
    treeCount,
    treePlanting: () => ({ ...treePlantingRef() }),
    treeCards: () => treeCardsRef(),
    grass: grassRef,
    buildProfile,
    furnitureCounts: furniture.counts,
    parkingCounts: parking.counts,
    barrierCounts: barriers.counts,
    sidewalkCounts: sidewalks.counts,
    signalCounts: signals.counts,
    stopBarCounts: stopbars.counts,
    bladeCounts: blades.counts,
    rockCounts: rocks.counts,
    waterStats: { lines: water.lines, areas: water.areas, falls: water.falls, length_m: water.length_m },
    junctionPaint: { bars: stopbars.counts, crosswalks: crosswalks.counts, arrows: arrows.counts },
    setStyle,
    setLight: (level: number, tint: THREE.Color, sun?: THREE.Vector3) => {
      grassRef?.setLight(level, tint)
      if (sun) grassRef?.setSun(sun)
      impRef?.setLight(level, tint)
      if (sun) shadowRef?.setSun(sun)
      if (crops) setCropLight(crops.group, level, tint, sun)
    },
    setWet: (wet: number) => {
      const w = Math.min(1, Math.max(0, wet))
      if (Math.abs(w - wetNow) < 0.005) return
      registerWet() // a road rebuilt by a knob change brings new materials with it
      wetNow = w
      for (const [m, base] of wettable) {
        m.roughness = base.roughness * (1 - w) + T.WET_ROUGHNESS * w
        m.metalness = base.metalness * (1 - w) + 0.12 * w
        m.envMapIntensity = base.env * (1 + (T.WET_REFLECT - 1) * w)
        m.color.copy(base.colour).multiplyScalar(1 - T.WET_DARKEN * w)
      }
    },
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
    weatherLook: () => precip?.presented() ?? WEATHER[precip?.current ?? 'clear'],
    weatherBlending: () => precip?.blending ?? false,
    get weather() {
      return { current: precip?.current ?? ('clear' as Weather), settled: precip?.settled ?? 0, particles: precip?.count ?? 0, wetness: precip?.wetness ?? 0 }
    },
    updateNear,
    nearPerf,
    retune,
    setSurfaces: (doc) => applySurfaces(doc),
    surfaces: () => surfacesDoc,
    setSeason,
    groundAt: groundAtWorld,
    physGroundAt: (x, z) => physGroundAtOut(x, z),
    decksNear: (x, z, r) => decksNearOut(x, z, r),
    edgeDistance: edgeDistanceWorld,
    setSplatMask: (u) => {
      let n = 0
      const seen = new Set<THREE.Material>()
      group.traverse((o) => {
        const m = (o as THREE.Mesh).material
        if (!m) return
        for (const mm of Array.isArray(m) ? m : [m]) {
          if (seen.has(mm)) continue
          seen.add(mm)
          // a self-lighting shader already owns its fragment shader; give it the uniforms and it
          // calls splatDissolve itself (grass.ts, impostors.ts, retro.ts)
          const sh = mm as THREE.ShaderMaterial
          if (sh.uniforms) {
            Object.assign(sh.uniforms, u)
            n++
            continue
          }
          makeSplatFading(mm, u)
          n++
        }
      })
      return { materials: n }
    },
    grassRoadDistance: (x, z) => grassRoadDistanceOut(x, z),
    grassBlocked: (x, z) => grassBlockedOut(x, z),
    edgeInfo: (x, z, exclude, roadsOnly) => edgeInfoOut(x, z, exclude, roadsOnly),
    edgeLevels: (x, z) => edgeLevelsOut(x, z),
    zoneAt: (x, z) => zoneAtOut(x, z),
    roadAt: (x, z) => roadAtOut(x, z),
    junctionMeet,
    vegCover: () => ({ loaded: veg?.loaded ?? 0, total: veg?.total ?? 0, inFlight: veg?.inFlightCount ?? 0, failed: veg?.failedCount ?? 0, lastMs: veg?.lastMs ?? null }),
    treesNear: treesNearWorld,
    terrain,
    /** tiled sites only: imagery streaming counts, for probes and the console */
    tiles: stream ? () => stream.counts : null,
    tileStream: stream,
    pyramid: pyr ? () => pyr.counts : null,
    pyramidStream: pyr,
    /** how many parsed vector tiles are cached; the LRU cap bounds this on a long drive */
    vtileCache: () => vectorTileCacheSize(),
    /** where the building build time went: massing loop, dressing loop, final normals pass */
    buildingsTiming: () => buildTiming,
    heightAt,
    lowestGround,
    graded: () => ({ built: gradeStats.built, total: gradeUnits.length, pendingNear: pendingNear(), strips: gradeStats.strips, buildings: gradeStats.buildings, ms: Math.round(gradeStats.ms), worstMs: Math.round(gradeStats.worstMs), worst: gradeStats.worst }),
    roadStream: () => {
      const near: { key: string; d: number }[] = []
      let nearBranch = 0, nearStreet = 0, nearBuildings = 0
      for (const u of gradeUnits) {
        if (u.done) continue
        const d = Math.hypot(u.x - gradeEye.x, u.z - gradeEye.z) - u.r
        if (d > T.STREAM_BUILD_M) continue
        near.push({ key: u.key, d: Math.round(d) })
        if (u.key.startsWith('branch')) nearBranch++
        else if (u.key.startsWith('street')) nearStreet++
        else if (u.key.startsWith('buildings')) nearBuildings++
      }
      near.sort((a, b) => a.d - b.d)
      return {
        pumping: gradePumping,
        current: currentUnitKey,
        pendingNear: pendingNear(),
        nearBranch,
        nearStreet,
        nearBuildings,
        nearest: near.slice(0, 10),
        branches: branchAts.length,
        meet: { calls: meetStats.calls, lastMs: Math.round(meetStats.lastMs), worstMs: Math.round(meetStats.worstMs), totalMs: Math.round(meetStats.totalMs), branches: meetStats.branches },
        spineWin: {
          windowed: windowedSpine,
          homeS: Math.round(homeS),
          pavedS: Math.round(pavedS),
          lo: Math.round(spineLo),
          hi: Math.round(spineHi),
          mainSt: mainSt.length,
          done: gradeUnits.find((u) => u.key === 'spine-window')?.done ?? null,
          eye: { x: Math.round(gradeEye.x), z: Math.round(gradeEye.z) },
          nearest: (() => { const n = nearestSpine(gradeEye.x, gradeEye.z); return { s: Math.round(n.s), dist: +n.dist.toFixed(1) } })(),
          vis: { base: roadBase.filter((o) => o.visible).length, holed: roadHoled.filter((o) => o.visible).length, skip: !!roadSkip },
        },
      }
    },
    spineAt,
    chains: () => {
      // the spine's tags are per segment; its middle stands for the whole for these numbers
      const mid = curveLen / 2
      const tg = segAt(mid)?.tags ?? {}
      return [
        { index: 0, name: tg.name ?? 'spine', ref: tg.ref ?? null, length_m: curveLen, lanes: lanesAt(mid), twoWay: twoWayAt(mid), half: pavedHalfAt(mid), highway: tg.highway ?? null, at: spineAt },
        ...branchAts.map((b, i) => ({ index: i + 1, name: b.name, ref: b.ref, length_m: b.len, lanes: b.lanes, twoWay: b.twoWay, half: b.half, highway: b.highway, at: b.at })),
      ]
    },
    /**
     * Hide the baked road over these stations, and rebuild it.
     *
     * The seam for stunt fixtures. Passing null puts the whole road back, which is what happens
     * when the last fixture on a site is deleted.
     */
    setSceneryClear: (polys: [number, number][][]) => {
      clearPolys = polys ?? []
      // the colliders go at once; the visible trees follow on the next replant, which this asks for
      reindexTrees()
      replantNow()
    },
    sceneryCleared: clearedAt,
    setRoadSkip: (fn: ((chain: number, s: number) => boolean) | null) => {
      roadSkip = fn
      buildRoads()
    },
    setImagery: (on) => {
      // A tile's map is its own — streamed 1 m NAIP, or the overview standing in until it lands —
      // so turning imagery off clears them all and turning it back on restores what each had.
      for (const m of terrainMats) {
        if (!on) m.map = null
        else if (m === terrainMat) m.map = imagery
        // a tile: its own streamed texture if resident, else its placeholder (the overview through
        // uv1), else bare — never the raw overview, which the first cut of this handed out and
        // which put the whole site's photo on every tile the overview did not reach
        else m.map = (m.userData.own as THREE.Texture | undefined) ?? (m.userData.placeholder as THREE.Texture | null) ?? null
        m.color.copy(on && m.map ? look(currentSeason).ground : bare)
        m.needsUpdate = true
      }
    },
    setWire: (on) => {
      for (const m of terrainMats) m.wireframe = on
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

function cutHorizon(geo: THREE.BufferGeometry, demBbox: [number, number, number, number], cell: number, heightAt: (x: number, y: number) => number, covered?: (x: number, y: number) => boolean) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const [x0, y0, x1, y1] = demBbox
  // A corridor site's near terrain fills its whole bbox, so "inside" is that rectangle. A tiled
  // NETWORK is different twice over: the hull is mostly empty, so cutting it whole would punch
  // holes in the horizon between the corridors, and the same cut is used again to take the 8 m
  // overview out from under the 2 m tiles. Both cases are "wherever this other surface covers".
  const inside = covered ?? ((x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1)
  const removed = new Uint8Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = -pos.getZ(i) // site frame
    if (!inside(x, y)) continue
    // deep = this point and its neighbourhood are covered, so no rim of the finer surface is close
    // enough for the coarse one to show through
    const d = cell * 1.5
    const deep = inside(x - d, y) && inside(x + d, y) && inside(x, y - d) && inside(x, y + d)
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
