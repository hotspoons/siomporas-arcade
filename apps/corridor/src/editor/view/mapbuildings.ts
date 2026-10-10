// The map's structures toggle: building footprints over the ground, around the view.
//
// Rich, 2026-10-10: *"Would be nice to have a toggle to turn on structures too."*
//
// WHY FOOTPRINTS, NOT THE GAME'S HOUSES. The site's massed buildings (walls, roofs, the lidar
// heights) are built by the game's streaming pump as the car reaches each kilometre, and the editor
// never runs that pump — it would plant trees, grass and street furniture with them. A map wants
// the outline anyway: flat fills with an edge, at the ground, one merged mesh per kilometre.
//
// AROUND THE VIEW ONLY, AND ONLY CLOSE. dc-metro has 446 193 footprints in 1 356 one-kilometre
// tiles, and a tile is up to 1.7 MB of JSON (the buildings share it with the sidewalks, the
// furniture and the branches). Drawing them all is neither useful nor affordable, so they appear
// below `BUILDINGS_MPP` metres a pixel, for the tiles within reach of the look-at point, and the
// cells furthest from it are dropped past a cap. A world that is not tiled has its footprints in
// the manifest already; those are bucketed into the same kilometre cells.
import * as THREE from 'three'
import { loadVectorTile, type Manifest } from '../../world/site'
import type { Site } from '../../world/scene'

/** shown at or below this many metres per CSS pixel */
export const BUILDINGS_MPP = 3
const CELL = 1000
const MAX_CELLS = 48
type Footprint = NonNullable<Manifest['buildings']>[number]

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 v = modelViewMatrix * vec4(position, 1.0);
  float len = max(length(v.xyz), 1e-3);
  v.xyz *= 1.0 - min(0.5, max(2.0 / len, 0.01));
  gl_Position = projectionMatrix * v;
  #include <logdepthbuf_vertex>
}
`
const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec4 uColor;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = uColor;
}
`
const mat = (r: number, g: number, b: number, a: number) => new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader: FRAG, uniforms: { uColor: { value: new THREE.Vector4(r, g, b, a) } },
  transparent: true, depthWrite: false, fog: false,
})

interface Cell { key: string; x: number; y: number; group: THREE.Group | null; loading: boolean; seen: number; count: number }

export class MapBuildings {
  readonly group = new THREE.Group()
  on = false
  readonly stats = { cells: 0, footprints: 0, loads: 0, buildMs: 0 }
  private site: Site | null = null
  private manifest: Manifest | null = null
  private resident = new Map<string, Footprint[]>() // an untiled world's footprints, by cell
  private cells = new Map<string, Cell>()
  private fill = mat(0.96, 0.82, 0.6, 0.42)
  private edge = mat(1, 0.88, 0.66, 0.9)
  private gen = 0
  private frame = 0

  constructor() {
    this.group.name = 'map:buildings'
  }

  attach(site: Site): void {
    this.clear()
    this.gen++
    this.site = site
    this.manifest = site.manifest
    if (!site.manifest.vt?.buildings?.length) {
      for (const b of site.manifest.buildings ?? []) {
        const p = b.ring?.[0]
        if (!p) continue
        const k = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`
        const list = this.resident.get(k)
        if (list) list.push(b)
        else this.resident.set(k, [b])
      }
    }
  }

  clear(): void {
    for (const c of this.cells.values()) this.drop(c)
    this.cells.clear()
    this.resident.clear()
    this.stats.cells = this.stats.footprints = 0
  }

  /** Once a frame: which cells are wanted, fetch and build them, drop the far ones. */
  update(mpp: number, focus: { x: number; y: number }, viewRadius: number): void {
    this.frame++
    const show = this.on && mpp <= BUILDINGS_MPP && !!this.site
    this.group.visible = show
    if (!show) return
    const r = Math.min(4000, Math.max(800, viewRadius))
    const want: { x: number; y: number; d: number }[] = []
    const tiles = this.manifest!.vt?.buildings
    if (tiles?.length) {
      const size = this.manifest!.vt!.size_m || CELL
      for (const t of tiles) {
        const d = Math.hypot((t.x + 0.5) * size - focus.x, (t.y + 0.5) * size - focus.y)
        if (d < r + size * 0.71) want.push({ x: t.x, y: t.y, d })
      }
    } else {
      for (const k of this.resident.keys()) {
        const [x, y] = k.split(',').map(Number)
        const d = Math.hypot((x + 0.5) * CELL - focus.x, (y + 0.5) * CELL - focus.y)
        if (d < r + CELL * 0.71) want.push({ x, y, d })
      }
    }
    want.sort((a, b) => a.d - b.d)
    let started = 0
    for (const w of want.slice(0, MAX_CELLS)) {
      const key = `${w.x},${w.y}`
      let c = this.cells.get(key)
      if (!c) this.cells.set(key, (c = { key, x: w.x, y: w.y, group: null, loading: false, seen: 0, count: 0 }))
      c.seen = this.frame
      if (!c.group && !c.loading && started < 2) {
        started++
        void this.load(c)
      }
    }
    for (const c of this.cells.values()) if (c.group) c.group.visible = c.seen === this.frame
    if (this.cells.size > MAX_CELLS) {
      const old = [...this.cells.values()].filter((c) => c.seen !== this.frame && !c.loading).sort((a, b) => a.seen - b.seen)
      for (const c of old.slice(0, this.cells.size - MAX_CELLS)) { this.drop(c); this.cells.delete(c.key) }
    }
  }

  private async load(c: Cell) {
    c.loading = true
    const gen = this.gen
    let list: Footprint[] = []
    const vt = this.manifest!.vt
    if (vt?.buildings?.length) {
      const files = await loadVectorTile(this.manifest!.slug, vt.dir, c.x, c.y)
      list = (files.buildings ?? []) as Footprint[]
      this.stats.loads++
    } else list = this.resident.get(c.key) ?? []
    c.loading = false
    if (gen !== this.gen || !this.site) return
    const t0 = performance.now()
    c.group = this.build(list)
    c.count = list.length
    this.group.add(c.group)
    this.stats.cells++
    this.stats.footprints += list.length
    this.stats.buildMs = +(performance.now() - t0).toFixed(1)
  }

  private build(list: Footprint[]): THREE.Group {
    const h = this.site!.heightAt
    const tri: number[] = []
    const edges: number[] = []
    for (const b of list) {
      const ring = b.ring
      if (!ring || ring.length < 3) continue
      let cx = 0, cy = 0
      for (const p of ring) { cx += p[0]; cy += p[1] }
      cx /= ring.length
      cy /= ring.length
      const z0 = h(cx, cy)
      const z = Number.isFinite(z0) ? z0 : 0
      const pts = ring.map((p) => new THREE.Vector2(p[0], p[1]))
      // a closed ring repeats its first point; earcut wants it once
      if (pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-3) pts.pop()
      const faces = THREE.ShapeUtils.triangulateShape(pts, [])
      for (const f of faces) for (const i of f) tri.push(pts[i].x, z, -pts[i].y)
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b2 = pts[(i + 1) % pts.length]
        edges.push(a.x, z, -a.y, b2.x, z, -b2.y)
      }
    }
    const g = new THREE.Group()
    const fg = new THREE.BufferGeometry()
    fg.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3))
    const fill = new THREE.Mesh(fg, this.fill)
    fill.renderOrder = 18
    const eg = new THREE.BufferGeometry()
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3))
    const edge = new THREE.LineSegments(eg, this.edge)
    edge.renderOrder = 19
    g.add(fill, edge)
    return g
  }

  private drop(c: Cell) {
    if (!c.group) return
    this.group.remove(c.group)
    c.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose() })
    this.stats.cells--
    this.stats.footprints -= c.count
    c.group = null
  }
}
