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
import { DATA_BASE } from './site'
import * as T from './tuning'

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
    field.tiles = world.tiles
      .filter((t) => (t.gaussians ?? 0) > 0)
      .filter((t) => !allow || allow.has(t.tile) || allow.has(t.chunk))
      .map((t) => {
      const [x0, y0, x1, y1] = t.bounds_enu_m
      v.set((x0 + x1) / 2, (y0 + y1) / 2, 0).applyMatrix4(field.toSite)
      return {
        name: `${base}tiles/${t.tile}`,
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
    field.spark = new SparkRenderer({ renderer })
    field.group.add(field.spark)
    return field
  }

  /** stream: the nearest unloaded tiles within range, and evict what has gone far away */
  update(eyeSiteX: number, eyeSiteY: number) {
    if (!T.SPLAT_ENABLED) {
      for (const t of this.tiles) this.drop(t)
      return
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
  const override = new URLSearchParams(location.search).get('splats')
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
