// A captured world inside the built one: gaussian splat tiles, streamed by locality.
//
// The design is docs/corridor/PLAN-SPLAT-CORRIDORS.md. What this file does is the middle of it:
// take a gaussworks world (`world.json` + `corridor.json` + tiles), put it exactly where the
// capture was, stream the tiles near the eye, and expose the one scalar the seam needs — how much
// of this point belongs to the splat rather than to the bake.
//
// THREE THINGS IT DELIBERATELY DOES NOT DO:
//
//   collision      the bake is always the ground and the barrier. A splat is a skin; drive
//                  through a splatted hedge and you hit the hedge the bake knows about, or
//                  nothing. That is what makes a capture safe to attach, move or delete.
//   fitting        `splats.json` carries a fitted transform as DATA. Fitting is a separate step
//                  with its own numbers; nothing here silently corrects anything.
//   sorting        Spark sorts its own gaussians. The procedural world fades out by dither, so
//                  there is never a blend order between the two to get wrong.
//
// The frame composition is the part worth reading twice. gaussworks anchors its ENU at the
// capture's own origin and the bake anchors at the site's; both are "east/north/up in metres",
// which invites treating the difference as a translation. It is not — the tangent planes are
// tilted with respect to each other, 1.4 m of swing across a 3 km world (the measurement is in
// tools/corridor/splats/frame-error.mjs) — so the two frames are composed through ECEF exactly.

import * as THREE from 'three'
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import { geodeticToEcef, enuBasis } from '@apex/engine/geo/wgs84'
import { DATA_BASE } from '../world/site'
import * as T from '../tuning'
import { angleBetween, shouldResort } from './splatsort'
import { param } from '../url'

/** `world.json` as gaussworks' merge writes it */
interface SplatWorld {
  frame: 'enu'
  origin: { lat: number; lon: number }
  cell_m: number
  tiles: {
    tile: string
    chunk: string
    bounds_enu_m: [number, number, number, number]
    /** GEODETIC, not metres — gaussworks' merge writes `{lat, lon}`. The stream uses
     *  `bounds_enu_m` instead, which is the right call anyway; this is here so nobody reaches for
     *  `centre[0]` and gets `undefined` rather than an error (splats lane, 2026-09-27). */
    centre?: { lat: number; lon: number }
    gaussians: number
  }[]
}

/** `corridor.json`: where the camera actually was */
interface CaptureCorridor {
  radius_m: number
  height_band_m: [number, number]
  passes: { points: [number, number, number][] }[]
}

/** the authored attachment: `<site>/splats.json` */
export interface SplatAttachment {
  id: string
  /** where the world's files are, e.g. `/splats/arrowhead-2026-09/` */
  base: string
  /** the fitted correction, in SITE metres and degrees — written by the fitter, never guessed here */
  fit?: { dx?: number; dy?: number; dz?: number; yaw_deg?: number }
  /**
   * Only these tiles, by file name. For a world that is partly wrong: the splats lane found that
   * 18 of the 29 tiles in arrowhead-2026-09 contain TWO COPIES of the road at different heights,
   * tens of metres apart, and that every one of those tiles registered 100% of its images --
   * registration is not correctness. Naming the healthy ones exercises the frame composition, the
   * streaming and the depth path against real data while the rest are re-run (2026-09-27).
   */
  tiles?: string[]
  /**
   * Which LOD directory to stream, naming a key of `world.json`'s `lods` block
   * (gaussworks writes each level to `tiles_<name>/`). Unset streams the full
   * tiles.
   *
   * This exists so the render path can be ASSERTED rather than assumed. The
   * full tiles are ~52-97 MB each and pulling two through a software
   * rasteriser kills the tab, which is why corridor-splatseam.mjs measures the
   * envelope with the stream switched off and loads no gaussians at all. The
   * `probe` level is the same tiles at 1/8 the gaussians with the spherical
   * harmonics dropped -- 2-3 MB -- which is small enough to actually draw
   * headlessly. Same filenames, same frame, same bounds.
   */
  lod?: string
  /** metres of crossfade outside the capture envelope */
  fade_m?: number
  /** multiplies the capture's own radius */
  core_scale?: number
  enabled?: boolean
}

interface Tile {
  name: string
  /** centre and radius in SITE metres, for the stream's distance test */
  cx: number
  cy: number
  r: number
  gaussians: number
  mesh: SplatMesh | null
  loading: boolean
  failed: boolean
  bytes: number
}

const SQ = (x: number) => x * x
const SCRATCH_EYE = new THREE.Vector3()
const SCRATCH_DIR = new THREE.Vector3()

export class SplatField {
  readonly group = new THREE.Group()
  private spark: SparkRenderer | null = null
  private tiles: Tile[] = []
  private passes: { x: number; y: number }[][] = []
  /** capture passes whose height band was impossible, and so were not used for the envelope */
  rejectedPasses = 0

  /** the envelope, for the seam raster: the passes in site metres and the tube around them */
  envelope(): { passes: { x: number; y: number }[][]; core: number; fade: number } {
    return { passes: this.passes, core: this.radius, fade: this.fade }
  }
  private band: [number, number] = [-1e9, 1e9]
  private radius = 25
  private fade = 15
  /** capture ENU -> site ENU, as a rigid transform */
  private toSite = new THREE.Matrix4()
  private bytes = 0
  private loads = 0
  private fails = 0
  readonly id: string
  /** where the camera was when the order was last rebuilt */
  private sortedAt = new THREE.Vector3(Infinity, Infinity, Infinity)
  /** when the order was last rebuilt, so the timer can be the floor it is meant to be */
  private sortedAtMs = 0
  /** which way the camera faced at the last sort: turning round presents unsorted gaussians */
  private sortedDir = new THREE.Vector3(0, 0, -1)
  /** something other than the camera changed — a tile arrived or went — so the order must be redone */
  private dirty = true
  /** how many re-sorts have been asked for, for the performance panel and for probes */
  sorts = 0

  private constructor(id: string) {
    this.id = id
    this.group.name = `splats:${id}`
  }

  /**
   * Load a world and place it in the site's frame. `anchor` is the SITE's geodetic anchor
   * (`manifest.frame.anchor`); everything else comes out of the world's own files.
   */
  static async attach(att: SplatAttachment, anchor: { lon: number; lat: number; h?: number }, renderer: THREE.WebGLRenderer): Promise<SplatField | null> {
    const base = att.base.endsWith('/') ? att.base : `${att.base}/`
    const get = async <T>(f: string): Promise<T | null> => {
      try {
        const r = await fetch(`${DATA_BASE}${base}${f}`, { cache: 'no-cache' })
        return r.ok ? ((await r.json()) as T) : null
      } catch {
        return null
      }
    }
    const world = await get<SplatWorld>('world.json')
    if (!world?.tiles?.length) {
      console.warn(`splats: ${att.id} has no world.json with tiles at ${base}`)
      return null
    }
    const field = new SplatField(att.id)
    field.fade = att.fade_m ?? 15
    // --- the frames ---------------------------------------------------------------------------
    // p_site = R_site^T · ( ECEF(capture) + R_capture · p_capture − ECEF(site) ), then the fitted
    // correction, then the viewer's own axis convention (site x,y,z = east,north,up → world
    // x,y,z = east, up, −north).
    const cap = { lon: world.origin.lon, lat: world.origin.lat, h: 0 }
    const Bc = enuBasis(cap.lon, cap.lat), Bs = enuBasis(anchor.lon, anchor.lat)
    const oc = geodeticToEcef(cap.lon, cap.lat, cap.h) as number[]
    const os = geodeticToEcef(anchor.lon, anchor.lat, anchor.h ?? 0) as number[]
    const d = [oc[0] - os[0], oc[1] - os[1], oc[2] - os[2]]
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    // capture ENU basis expressed in the site's ENU basis
    const m = new THREE.Matrix4().set(
      dot(Bs.east, Bc.east), dot(Bs.east, Bc.north), dot(Bs.east, Bc.up), dot(Bs.east, d),
      dot(Bs.north, Bc.east), dot(Bs.north, Bc.north), dot(Bs.north, Bc.up), dot(Bs.north, d),
      dot(Bs.up, Bc.east), dot(Bs.up, Bc.north), dot(Bs.up, Bc.up), dot(Bs.up, d),
      0, 0, 0, 1,
    )
    const fit = new THREE.Matrix4()
      .makeRotationZ(((att.fit?.yaw_deg ?? 0) * Math.PI) / 180)
      .setPosition(att.fit?.dx ?? 0, att.fit?.dy ?? 0, att.fit?.dz ?? 0)
    field.toSite.multiplyMatrices(fit, m)
    // site ENU (east, north, up) -> three world (east, up, −north)
    const toWorld = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)
    field.group.matrixAutoUpdate = false
    field.group.matrix.multiplyMatrices(toWorld, field.toSite)
    field.group.matrixWorldNeedsUpdate = true
    // --- the envelope, in site metres ------------------------------------------------------
    const corridor = await get<CaptureCorridor>('corridor.json')
    if (corridor?.passes?.length) {
      field.radius = (corridor.radius_m ?? 25) * (att.core_scale ?? 1)
      field.band = corridor.height_band_m ?? field.band
      const v = new THREE.Vector3()
      /*
       * REJECT THE PASSES THAT CANNOT BE WHERE THEY SAY THEY ARE.
       *
       * 7 of the 72 passes in arrowhead-2026-09 sit more than 15 m from any road, and one carries
       * `u` from -27 m to -17 m -- below the ENU origin, where the real MSL ground here is 20 to
       * 85 m. Those are misplaced reconstructions, not terrain. They are a minority, and they are
       * exactly the kind of outlier that drags an envelope (and would drag a fit) outwards.
       *
       * The test is the capture's OWN height band, which it published, so this needs no second
       * opinion about where the ground is (splats lane, 2026-09-27).
       */
      const lo = field.band[0] - 5
      const hi = field.band[1] + 5
      let rejected = 0
      field.passes = corridor.passes
        .filter((p) => {
          const bad = p.points.filter(([, , u]) => u < lo || u > hi).length
          if (bad > p.points.length * 0.5) { rejected++; return false }
          return true
        })
        .map((p) =>
          p.points.map(([e, n, u]) => {
            v.set(e, n, u).applyMatrix4(field.toSite)
            return { x: v.x, y: v.y }
          }),
        )
      field.rejectedPasses = rejected
    }
    // --- the tiles ---------------------------------------------------------------------------
    const v = new THREE.Vector3()
    // A TILE CAN BE REAL AND EMPTY. `chunk_x-2_y1.ply` in arrowhead-2026-09 is a valid PLY with a
    // valid header and zero vertices: it trained 117,861 gaussians whose reconstruction landed
    // outside its own cell, so none survived the ownership test. Skipping on file existence would
    // load it, spend a slot on it and hold it resident for ever (splats lane, 2026-09-27).
    const allow = att.tiles?.length ? new Set(att.tiles) : null
    // A named LOD must EXIST in world.json, or we would silently stream 404s and
    // report a world with no resident tiles as if it were merely far away.
    const lods = (world as { lods?: Record<string, { dir?: string }> }).lods
    let tileDir = 'tiles'
    if (att.lod) {
      const dir = lods?.[att.lod]?.dir
      if (dir) tileDir = dir
      else console.warn(`splats: ${att.id} has no lod '${att.lod}' in world.json; streaming full tiles`)
    }
    field.tiles = world.tiles
      .filter((t) => (t.gaussians ?? 0) > 0)
      .filter((t) => !allow || allow.has(t.tile) || allow.has(t.chunk))
      .map((t) => {
      const [x0, y0, x1, y1] = t.bounds_enu_m
      v.set((x0 + x1) / 2, (y0 + y1) / 2, 0).applyMatrix4(field.toSite)
      return {
        name: `${base}${tileDir}/${t.tile}`,
        cx: v.x,
        cy: v.y,
        r: Math.hypot(x1 - x0, y1 - y0) / 2,
        gaussians: t.gaussians,
        mesh: null,
        loading: false,
        failed: false,
        bytes: 0,
      }
    })
    // Spark renders every SplatMesh in the scene; one renderer for the whole viewer. Its shaders
    // already carry three's logarithmic-depth chunks, which is why this can share a scene with a
    // world drawn under logarithmicDepthBuffer at all.
    // minSortIntervalMs, because Spark's default of 0 means "re-sort whenever
    // you like" and the sort is the ONLY thing the capture costs: measured on a
    // real GPU with 2.2M gaussians resident, the median frame is the same with
    // the capture on and off, and the p90 is 59 ms against 18 ms. See
    // SPLAT_SORT_MS in tuning.ts for the numbers.
    field.spark = new SparkRenderer({ renderer, minSortIntervalMs: T.SPLAT_SORT_MS })
    /*
     * WE DECIDE WHEN TO RE-SORT, NOT SPARK.
     *
     * Rich, 2026-09-29, from the performance panel: *"the splats sorting frequency seems to be
     * driving the stalls… I don't understand why the sort needs to be run at all, or at least as
     * often as it is."*
     *
     * It needs to run because gaussians are ALPHA-BLENDED: the blend is order-dependent, so they
     * have to be drawn back-to-front from wherever you are standing. It ran as often as it did
     * because Spark's own test for "the view changed" is `moved more than 1 mm, or turned more than
     * 2.6°` — which in a moving car is true on every single frame, so `minSortIntervalMs` was the
     * only thing holding it back.
     *
     * AND TURNING CANNOT CHANGE THE ORDER AT ALL. `sortRadial` sorts by DISTANCE from the camera,
     * which is rotation-invariant; a car going round a bend re-sorted for nothing. So: auto-update
     * off, and `step()` below asks for one only when the camera has TRANSLATED far enough to
     * matter, where "enough" is a fraction of the distance to the nearest capture.
     */
    field.spark.autoUpdate = false
    field.spark.sortRadial = true
    field.group.add(field.spark)
    return field
  }

  /** stream: the nearest unloaded tiles within range, and evict what has gone far away */
  /**
   * Decide whether the splat order needs rebuilding this frame, and rebuild it if so.
   *
   * THE COST IS NOT THE SORT. The sort itself runs in a worker. What a re-sort costs is a GPU pass
   * that writes every gaussian's depth, a readback of that buffer to the CPU — about 10 MB with
   * 2.5M gaussians resident — and an ordering texture of the same size uploaded back. A 20 MB round
   * trip through the bus, per sort, on the frame that asks for it. That is the stall.
   *
   * THE RULE IS TWO GATES, and the TIMER is the one that matters at speed: a sort may happen at
   * most once every `SPLAT_SORT_MS`, and only then if the camera has also moved far enough for the
   * order to have changed. At 180 mph the timer decides everything; parked, the distance decides,
   * and the answer is never. See `splatsort.ts` — the first version had only the distance gate,
   * which fires MORE often the faster you drive, which is backwards for this game.
   */
  step(camera: THREE.Camera, scene: THREE.Scene) {
    const spark = this.spark
    if (!spark) return
    /*
     * OFF STILL NEEDS ONE MORE UPDATE. `update` drops every tile the moment the knob goes to zero,
     * but Spark draws from what it was last handed, not from the scene graph — so with the sort
     * skipped as well the dropped tiles kept being drawn until something else forced a sort, which
     * in practice was a reload (Rich, 2026-09-30: "Splats can't be disabled unless you refresh").
     * One update with the tiles gone is what tells it, and then it really is off.
     */
    if (!T.SPLAT_ENABLED) {
      if (this.dirty) { this.dirty = false; spark.update({ scene, camera }) }
      return
    }
    const eye = camera.getWorldPosition(SCRATCH_EYE)
    const dir = camera.getWorldDirection(SCRATCH_DIR)
    const now = performance.now()
    const since = now - this.sortedAtMs
    const turned = angleBetween(this.sortedDir, dir)
    if (!this.dirty && !shouldResort(since, this.sortedAt.distanceTo(eye), turned, this.nearestLoaded(eye))) return
    this.dirty = false
    this.sortedAt.copy(eye)
    this.sortedDir.copy(dir)
    this.sortedAtMs = now
    this.sorts++
    spark.update({ scene, camera })
  }

  /** Metres to the nearest loaded tile's edge, or Infinity when none are loaded. */
  private nearestLoaded(eye: THREE.Vector3): number {
    let best = Infinity
    const x = eye.x
    const y = -eye.z
    for (const t of this.tiles) {
      if (!t.mesh) continue
      best = Math.min(best, Math.max(0, Math.hypot(t.cx - x, t.cy - y) - t.r))
    }
    return best
  }

  update(eyeSiteX: number, eyeSiteY: number) {
    if (!T.SPLAT_ENABLED) {
      for (const t of this.tiles) this.drop(t)
      return
    }
    // keep the knob live: it is the one people will reach for when it stutters
    if (this.spark && this.spark.minSortIntervalMs !== T.SPLAT_SORT_MS) {
      this.spark.minSortIntervalMs = T.SPLAT_SORT_MS
    }
    const load = T.SPLAT_LOAD_M, keep = T.SPLAT_KEEP_M
    let inFlight = 0
    for (const t of this.tiles) if (t.loading) inFlight++
    let best: Tile | null = null
    let bd = Infinity
    for (const t of this.tiles) {
      const d = Math.max(0, Math.hypot(t.cx - eyeSiteX, t.cy - eyeSiteY) - t.r)
      if (t.mesh && d > keep) this.drop(t)
      if (t.mesh || t.loading || t.failed || d > load) continue
      if (d < bd) { bd = d; best = t }
    }
    if (best && inFlight < 2 && this.bytes < T.SPLAT_BUDGET_MB * 1e6) void this.load(best)
  }

  private async load(t: Tile) {
    t.loading = true
    try {
      const mesh = new SplatMesh({ url: `${DATA_BASE}${t.name}` })
      await mesh.initialized
      t.mesh = mesh
      this.dirty = true
      t.bytes = t.gaussians * 32 // the packed form, near enough for a budget
      this.bytes += t.bytes
      this.loads++
      this.group.add(mesh)
    } catch (e) {
      t.failed = true
      this.fails++
      console.warn(`splats: ${t.name}: ${(e as Error).message}`)
    } finally {
      t.loading = false
    }
  }

  private drop(t: Tile) {
    if (!t.mesh) return
    this.dirty = true
    this.group.remove(t.mesh)
    t.mesh.dispose?.()
    t.mesh = null
    this.bytes -= t.bytes
    t.bytes = 0
  }

  /**
   * HOW MUCH OF THIS POINT BELONGS TO THE SPLAT, 0…1 — in site metres.
   *
   * The softened capture envelope, times whether the tile covering it is actually resident. That
   * second factor is what makes a missing or failed tile harmless: the weight goes to zero and
   * the built world simply stays, which is the whole reason the procedural layer is kept alive
   * underneath rather than replaced.
   */
  weightAt(x: number, y: number, z?: number): number {
    if (!T.SPLAT_ENABLED || !this.passes.length) return 0
    if (z !== undefined && (z < this.band[0] || z > this.band[1])) return 0
    let best = Infinity
    for (const pass of this.passes) {
      for (let i = 1; i < pass.length; i++) {
        const a = pass[i - 1], b = pass[i]
        const dx = b.x - a.x, dy = b.y - a.y
        const L = dx * dx + dy * dy || 1
        const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L))
        const d2 = SQ(a.x + u * dx - x) + SQ(a.y + u * dy - y)
        if (d2 < best) best = d2
      }
    }
    const d = Math.sqrt(best)
    const core = this.radius
    const env = 1 - THREE.MathUtils.smoothstep(d, core, core + Math.max(0.1, this.fade))
    if (env <= 0) return 0
    // resident? the tile whose box contains the point
    for (const t of this.tiles) {
      if (Math.hypot(t.cx - x, t.cy - y) > t.r * 1.45) continue
      return t.mesh ? env : 0
    }
    return 0
  }

  counts() {
    return {
      id: this.id,
      tiles: this.tiles.length,
      passes: this.passes.length,
      rejectedPasses: this.rejectedPasses,
      resident: this.tiles.filter((t) => t.mesh).length,
      loading: this.tiles.filter((t) => t.loading).length,
      failed: this.fails,
      loads: this.loads,
      MB: +(this.bytes / 1e6).toFixed(1),
      radius_m: this.radius,
      fade_m: this.fade,
      gaussians: this.tiles.reduce((n, t) => n + (t.mesh ? t.gaussians : 0), 0),
    }
  }

  dispose() {
    for (const t of this.tiles) this.drop(t)
    this.spark?.dispose?.()
    this.group.removeFromParent()
  }
}

/** what a site says it has attached; `?splats=<world>` attaches one by hand for testing */
export async function attachmentsFor(slug: string): Promise<SplatAttachment[]> {
  const override = param('splats')
  if (override === 'off') return []
  if (override) return [{ id: override, base: `/splats/${override}/`, enabled: true }]
  try {
    const r = await fetch(`${DATA_BASE}/sites/${slug}/splats.json`, { cache: 'no-cache' })
    if (!r.ok) return []
    const doc = (await r.json()) as { worlds?: SplatAttachment[] }
    return (doc.worlds ?? []).filter((w) => w.enabled !== false)
  } catch {
    return []
  }
}
