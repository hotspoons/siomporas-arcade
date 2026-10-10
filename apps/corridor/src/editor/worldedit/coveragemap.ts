// The OSM data dialog's map: which ground each Overpass instance holds, and where every world sits
// on it.
//
// ITS OWN SMALL CANVAS, ON THE MAIN MAP'S PROJECTION. `MapView` (map.ts) is the world-drawing map:
// a ring editor, a road picker and a tile loader, wired to the page's world state. This needs none
// of that and must not disturb it, so it borrows map.ts's Web Mercator (`project`) and draws its own
// handful of polygons. Pan with a drag, zoom with the wheel about the cursor.
//
// HOW A PROBLEM LOOKS. A world is filled with the colour of the instance that serves it. A world no
// single instance holds is outlined in red and hatched. And while a `#s/w/n/e` fence is still on a
// URL, a world the fences would send to an instance that does not hold all of it has the MISSING
// PART filled red — computed on the canvas, not guessed: the world is painted red on a scratch layer
// and that instance's real coverage is cut out of it (`destination-out`), so what stays red is
// exactly the ground the old routing would have baked as empty. For dc-metro-take-2 against the
// Maryland instance that is Washington and everything across the Potomac.

import { project, unproject } from './map'
import type { BorderFeature, CoverageUpstream, CoverageWorld, GeoJsonPolygonal } from './api'
import { upstreamColour, worldVerdict } from './osmregions'

type Ring = number[][]

const polysOf = (g: GeoJsonPolygonal | undefined | null): Ring[][] => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.coordinates)

export class CoverageMap {
  centre = { lon: -77.0, lat: 39.0 }
  zoom = 5
  borders: BorderFeature[] = []
  upstreams: CoverageUpstream[] = []
  worlds: CoverageWorld[] = []
  preview: { geometry: GeoJsonPolygonal; label: string } | null = null
  /** upstreams switched off in the legend */
  hidden = new Set<string>()

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private scratch = document.createElement('canvas')
  private w = 1
  private h = 1
  private dpr = 1
  private frame = 0
  private drag: { x: number; y: number; cx: number; cy: number } | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    new ResizeObserver(() => this.resize()).observe(canvas)
    canvas.addEventListener('pointerdown', (e) => {
      const [cx, cy] = project(this.centre)
      this.drag = { x: e.clientX, y: e.clientY, cx, cy }
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return
      const s = 2 ** this.zoom
      this.centre = unproject(this.drag.cx - (e.clientX - this.drag.x) / s, this.drag.cy - (e.clientY - this.drag.y) / s)
      this.draw()
    })
    const end = () => { this.drag = null }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const before = this.toLonLat(e.clientX - r.left, e.clientY - r.top)
      this.zoom = Math.max(1, Math.min(14, this.zoom - Math.sign(e.deltaY) * 0.5))
      // keep the point under the cursor where it was
      const after = this.toLonLat(e.clientX - r.left, e.clientY - r.top)
      const [cx, cy] = project(this.centre)
      const [bx, by] = project(before)
      const [ax, ay] = project(after)
      this.centre = unproject(cx + (bx - ax), cy + (by - ay))
      this.draw()
    }, { passive: false })
    this.resize()
  }

  /** Frame a lon/lat box with a margin. */
  fit(b: { south: number; west: number; north: number; east: number }) {
    const [x0, y1] = project({ lon: b.west, lat: b.south })
    const [x1, y0] = project({ lon: b.east, lat: b.north })
    const z = Math.log2(Math.min(this.w / Math.max(1e-9, x1 - x0), this.h / Math.max(1e-9, y1 - y0))) - 0.3
    this.zoom = Math.max(1, Math.min(13, z))
    this.centre = unproject((x0 + x1) / 2, (y0 + y1) / 2)
    this.draw()
  }

  private resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    this.w = Math.max(1, Math.round(r.width))
    this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.scratch.width = this.canvas.width
    this.scratch.height = this.canvas.height
    this.draw()
  }

  private toLonLat(x: number, y: number) {
    const [cx, cy] = project(this.centre)
    const s = 2 ** this.zoom
    return unproject(cx + (x - this.w / 2) / s, cy + (y - this.h / 2) / s)
  }

  private xy(lon: number, lat: number): [number, number] {
    const [cx, cy] = project(this.centre)
    const [x, y] = project({ lon, lat })
    const s = 2 ** this.zoom
    return [this.w / 2 + (x - cx) * s, this.h / 2 + (y - cy) * s]
  }

  private path(g: CanvasRenderingContext2D, polys: Ring[][]) {
    g.beginPath()
    for (const poly of polys) {
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => {
          const [x, y] = this.xy(lon, lat)
          if (i) g.lineTo(x, y)
          else g.moveTo(x, y)
        })
        g.closePath()
      }
    }
  }

  /** A world's footprint as polygons: its drawn ring, else the box the bake will ask about. */
  private footprint(w: CoverageWorld): Ring[][] {
    if (w.ring && w.ring.length >= 3) return [[[...w.ring, w.ring[0]]]]
    const b = w.box
    if (!b) return []
    return [[[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]]]
  }

  draw() {
    if (this.frame) return
    // rendering only — nothing waits on this frame (see map.ts on rAF in a background tab)
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  /** for the probe: what the last paint drew */
  painted = { upstreams: 0, worlds: 0, missing: 0 }

  private paint() {
    const g = this.ctx
    const css = getComputedStyle(document.documentElement)
    const tok = (n: string, d: string) => css.getPropertyValue(n).trim() || d
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = tok('--bg-0', '#0d1014')
    g.fillRect(0, 0, this.w, this.h)

    // land, so the polygons have somewhere to be
    g.fillStyle = tok('--bg-2', '#1c232b')
    g.strokeStyle = tok('--line-2', '#3a4652')
    g.lineWidth = 0.6
    for (const f of this.borders) {
      this.path(g, polysOf(f.geometry as GeoJsonPolygonal))
      g.fill('evenodd')
      g.stroke()
    }

    // each instance's coverage, in its colour
    let nUp = 0
    this.upstreams.forEach((u, i) => {
      if (this.hidden.has(u.name)) return
      const c = upstreamColour(i)
      for (const r of u.regions) {
        if (!r.geometry) continue
        this.path(g, polysOf(r.geometry))
        g.fillStyle = `${c}22`
        g.fill('evenodd')
        g.strokeStyle = c
        g.lineWidth = 1.5
        g.setLineDash(r.source === 'fence' ? [6, 4] : [])
        g.stroke()
        g.setLineDash([])
        nUp++
      }
    })

    // worlds
    const danger = tok('--danger', '#e2685f')
    let nMissing = 0
    for (const w of this.worlds) {
      if (!w.placed) continue
      const fp = this.footprint(w)
      const v = worldVerdict(w)
      const ui = w.upstream ? this.upstreams.findIndex((u) => u.name === w.upstream) : -1
      this.path(g, fp)
      if (ui >= 0) {
        g.fillStyle = `${upstreamColour(ui)}66`
        g.fill('evenodd')
      }
      g.strokeStyle = v.kind === 'ok' ? (ui >= 0 ? upstreamColour(ui) : tok('--ink-2', '#a3b1bf')) : danger
      g.lineWidth = v.kind === 'ok' ? 2 : 2.5
      g.stroke()
      if (v.kind === 'mirrors') {
        g.save()
        this.path(g, fp)
        g.clip('evenodd')
        g.strokeStyle = `${danger}99`
        g.lineWidth = 1
        for (let k = -this.h; k < this.w; k += 9) {
          g.beginPath()
          g.moveTo(k, 0)
          g.lineTo(k + this.h, this.h)
          g.stroke()
        }
        g.restore()
      }
      // THE MISSING GROUND: the world, minus the real coverage of where the fences send it
      if (v.kind === 'misrouted' && w.fences?.upstream) {
        const up = this.upstreams.find((u) => u.name === w.fences!.upstream)
        const s = this.scratch.getContext('2d')!
        s.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        s.clearRect(0, 0, this.w, this.h)
        this.path(s, fp)
        s.fillStyle = `${danger}cc`
        s.fill('evenodd')
        s.globalCompositeOperation = 'destination-out'
        for (const r of up?.regions ?? []) {
          if (!r.geometry) continue
          this.path(s, polysOf(r.geometry))
          s.fillStyle = '#000'
          s.fill('evenodd')
        }
        s.globalCompositeOperation = 'source-over'
        g.save()
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.drawImage(this.scratch, 0, 0)
        g.restore()
        nMissing++
      }
      if (this.zoom >= 4) {
        const b = w.box
        if (b) {
          const [x, y] = this.xy(b.west, b.north)
          g.font = `600 11px ${tok('--font-body', 'sans-serif')}`
          g.fillStyle = v.kind === 'ok' ? tok('--ink-1', '#e6ecf2') : danger
          g.fillText(w.slug, x + 3, y - 4)
        }
      }
    }

    // the region a person is looking at in the picker
    if (this.preview) {
      this.path(g, polysOf(this.preview.geometry))
      g.fillStyle = 'rgba(255,255,255,0.10)'
      g.fill('evenodd')
      g.strokeStyle = tok('--ink-1', '#e6ecf2')
      g.setLineDash([5, 4])
      g.lineWidth = 1.5
      g.stroke()
      g.setLineDash([])
    }
    this.painted = { upstreams: nUp, worlds: this.worlds.filter((w) => w.placed).length, missing: nMissing }
  }
}
