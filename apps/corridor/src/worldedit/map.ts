// The map: a layer stack, from country outlines down to every street a car can drive.
//
// WHAT THIS REPLACES. The first version drew exactly one thing — the drivable ways the bake would
// chain — and made everything else impossible: zoom out to look for a pass in the Alps and the
// screen went black by design. That is a site definer. A world editor has to let you start at the
// world, so the map asks a different question at every scale, and the scales are:
//
//   borders   country outlines            once, cached; Natural Earth, not Overpass
//   cities    world cities, ranked        once, cached; the overview's place layer
//   places    towns and villages          Overpass, tiled, from zoom 6
//   major     motorways and trunk roads   Overpass, tiled, from zoom 7
//   roads     every drivable street       Overpass, tiled, from zoom 11 — what the bake will chain
//
// The server owns which layers apply at which zoom (`/api/osm/layers`, `/api/osm/plan`) because it
// also owns the queries; a client that hard-coded zoom numbers would drift from them.
//
// THERE IS STILL NO RASTER BASEMAP, and that is deliberate rather than unfinished. What matters
// here is what the bake will see, and vector outlines say that exactly, work with no route off the
// cluster, and carry no tile-usage policy for a tool that pans across a continent.
//
// PROJECTION. Web Mercator, because that is what every map gesture people already know assumes,
// and because pan and zoom are then a translation and a scale with no trigonometry per frame.
// Nothing here is ever site metres: see tools/worldeditor/geo.mjs for why the whole editor stays
// in lon/lat. The scale bar is computed from the latitude at the cursor, so it is honest at any
// zoom rather than quietly being a Mercator metre.
//
// FRAMES. `requestAnimationFrame` is used for RENDERING and nothing else. Every fetch, poll and
// timer in this app is a `setTimeout`, because rAF does not fire in a background tab — a budgeted
// loop that yielded on it froze a whole build on 2026-09-21 and cost two rounds of blaming the
// geodesy. A map that stops repainting while you are not looking at it is correct behaviour.

import type { Way } from './api'

export interface LonLat {
  lon: number
  lat: number
}

export interface TileDoc {
  layer: string
  z: number
  x: number
  y: number
  kind: 'points' | 'lines'
  bounds: { south: number; west: number; north: number; east: number }
  items: unknown[]
}

export interface PlacePoint {
  id: number
  name: string
  kind: string
  pop: number
  lat: number
  lon: number
}

export interface MajorLine {
  id: number
  name: string | null
  ref: string | null
  highway: string
  line: [number, number][]
}

/** A circle and the square the bake will actually take around it. */
export interface Extent {
  centre: LonLat
  radius_m: number
}

const TILE = 256
const MAX_LAT = 85.05112878

/** Web Mercator world coordinates at zoom 0, in "pixels" where the world is 256 wide. */
export function project(p: LonLat): [number, number] {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat))
  const s = Math.sin((lat * Math.PI) / 180)
  return [((p.lon + 180) / 360) * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE]
}

export function unproject(x: number, y: number): LonLat {
  const lon = (x / TILE) * 360 - 180
  const n = Math.PI - 2 * Math.PI * (y / TILE)
  return { lon, lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) }
}

/** Ground metres per screen pixel at this latitude and zoom — what the scale bar is built from. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/* ------------------------------------------------------------------------------------------- */

/** How a way is drawn. Width is in screen px and does not scale with zoom: at z13 a residential
 *  street drawn to its real 6 m would be a third of a pixel, and the map would be empty. */
const STYLE: Record<string, { w: number; c: string; minZoom: number }> = {
  motorway: { w: 3.5, c: '#e2685f', minZoom: 0 },
  trunk: { w: 3.2, c: '#d9884f', minZoom: 0 },
  primary: { w: 2.8, c: '#d9a441', minZoom: 0 },
  secondary: { w: 2.4, c: '#b3b04a', minZoom: 10 },
  tertiary: { w: 2.0, c: '#8fae6a', minZoom: 11 },
  unclassified: { w: 1.6, c: '#8a97a4', minZoom: 12 },
  residential: { w: 1.6, c: '#8a97a4', minZoom: 12 },
  living_street: { w: 1.4, c: '#78848f', minZoom: 13 },
}
const LINK = { w: 1.6, c: '#c08a5a', minZoom: 12 }
const styleOf = (hw: string) => STYLE[hw] ?? (hw?.endsWith('_link') ? LINK : { w: 1.2, c: '#6b7a89', minZoom: 13 })

export type Mode = 'pan' | 'draw' | 'pick'

export interface MapOpts {
  canvas: HTMLCanvasElement
  /** the viewport settled — time to ask for roads */
  onViewport: (bbox: { south: number; west: number; north: number; east: number }, zoom: number) => void
  /** the drawn ring changed (a vertex added, moved, removed, or the ring closed) */
  onBoundary: (ring: LonLat[], closed: boolean) => void
  /** a road was clicked in `pick` mode */
  onPick: (way: Way, additive: boolean) => void
  /** the cursor moved — for the coordinate readout */
  onHover: (p: LonLat, mPerPx: number) => void
}

export class MapView {
  centre: LonLat = { lon: -76.683, lat: 39.004 }
  zoom = 14
  mode: Mode = 'pan'
  ways: Way[] = []
  /** Country outlines, drawn under everything. Loaded once by main.ts. */
  borders: { geometry: { type: string; coordinates: number[][][] | number[][][][] }; properties: { name: string | null } }[] = []
  /** World cities, ranked — what stands in for `places` below its minimum zoom. */
  worldCities: { name: string; country: string | null; pop: number; rank: number; lat: number; lon: number }[] = []
  /** Fetched tiles, keyed `layer/z/x/y`. The map draws whatever it holds. */
  tiles = new Map<string, TileDoc>()
  /**
   * Has the view been moved since the page loaded?
   *
   * `boot()` flies to a starting world, and it does so AFTER awaiting the world list — so anything
   * that moved the map in the meantime (a probe, a search, a person who started panning while the
   * list was loading) got yanked back a second later. The flag lets boot say "only if nobody has
   * touched it", which is the behaviour anyone would expect and which a probe depends on.
   */
  moved = false

  /** Indexed places, drawn as pins at every zoom — the index is the point of the index. */
  pins: { id: string; name: string; lat: number; lon: number; world: boolean }[] = []
  /**
   * Each layer's zoom band, from the server — the same numbers that choose the queries.
   *
   * DRAWING IS GATED ON THIS, not only fetching. A tile stays in memory after you zoom away from
   * it (so coming back is instant), and without a gate the detail layer is still drawn at world
   * zoom: 59 544 street segments from a previous session, painted over the Atlantic, at a scale
   * where every one of them is a fraction of a pixel. It cost about a second a frame and looked
   * like a rendering bug.
   */
  bands = new Map<string, { minZoom: number; maxZoom: number }>()
  /** the ring being drawn, or the saved one being edited */
  ring: LonLat[] = []
  ringClosed = false
  /** what the bake would take: drawn as BOTH the circle and the square, because it takes the square */
  extent: Extent | null = null
  /** other worlds, drawn faintly so a new one can be placed beside them rather than on them */
  others: { slug: string; centre: LonLat; radius_m: number; baked: boolean }[] = []
  /** idents the person has picked, highlighted */
  picked = new Set<string>()
  /** ways under the cursor, highlighted */
  hovered: number | null = null

  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private o: MapOpts
  private dpr = 1
  private w = 0
  private h = 0
  private frame = 0
  private settleTimer = 0
  private dragging: { x: number; y: number; moved: boolean; vertex: number | null } | null = null

  constructor(o: MapOpts) {
    this.o = o
    this.canvas = o.canvas
    this.ctx = this.canvas.getContext('2d')!
    this.resize()
    // A ResizeObserver ON THE CANVAS, not a window `resize` listener. The canvas changes size for
    // reasons the window does not know about: the top bar grows a line when a world is selected
    // (which moves `--we-bar-h`), and the inspector is a different width at phone width. A window
    // listener left the drawing buffer one layout behind — 900 px of buffer in an 887 px box, so
    // the bottom 13 px of the map were a stretched copy of themselves.
    new ResizeObserver(() => this.resize()).observe(this.canvas)
    this.bind()
    this.settle(0)
  }

  /* ---- viewport ---------------------------------------------------------------------------- */

  private resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    this.w = Math.max(1, Math.round(r.width))
    this.h = Math.max(1, Math.round(r.height))
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.draw()
    this.settle()
  }

  /** Screen px per zoom-0 world unit. */
  private get scale() {
    return 2 ** this.zoom
  }

  toScreen(p: LonLat): [number, number] {
    const [wx, wy] = project(p)
    const [cx, cy] = project(this.centre)
    return [this.w / 2 + (wx - cx) * this.scale, this.h / 2 + (wy - cy) * this.scale]
  }

  toLonLat(x: number, y: number): LonLat {
    const [cx, cy] = project(this.centre)
    return unproject(cx + (x - this.w / 2) / this.scale, cy + (y - this.h / 2) / this.scale)
  }

  bbox() {
    const a = this.toLonLat(0, 0)
    const b = this.toLonLat(this.w, this.h)
    return { north: a.lat, west: a.lon, south: b.lat, east: b.lon }
  }

  get metresPerPixel() {
    return metresPerPixel(this.centre.lat, this.zoom)
  }

  /** The canvas in CSS pixels — what `frame()` needs to work out a zoom from an extent. */
  get canvasSize() {
    return { w: this.w, h: this.h }
  }

  flyTo(p: LonLat, zoom?: number, { user = true } = {}) {
    if (user) this.moved = true
    this.centre = { ...p }
    if (zoom != null) this.zoom = zoom
    this.draw()
    this.settle()
  }

  /**
   * Ask for roads once the gesture has stopped.
   *
   * A `setTimeout`, not a frame callback: a person who starts a drag, tabs away and comes back
   * must still get their roads. Rendering may legitimately stop in a background tab; fetching a
   * thing that was asked for before the tab lost focus may not.
   */
  private settle(ms = 350) {
    clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.o.onViewport(this.bbox(), this.zoom), ms)
  }

  /* ---- input ------------------------------------------------------------------------------- */

  private bind() {
    const c = this.canvas
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId)
      const v = this.mode === 'draw' ? this.vertexAt(e.offsetX, e.offsetY) : null
      this.dragging = { x: e.offsetX, y: e.offsetY, moved: false, vertex: v }
    })
    c.addEventListener('pointermove', (e) => {
      const p = this.toLonLat(e.offsetX, e.offsetY)
      this.o.onHover(p, this.metresPerPixel)
      if (this.dragging) {
        const dx = e.offsetX - this.dragging.x
        const dy = e.offsetY - this.dragging.y
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          this.dragging.moved = true
          this.moved = true
        }
        if (this.dragging.vertex != null) {
          this.ring[this.dragging.vertex] = p
          this.o.onBoundary(this.ring, this.ringClosed)
        } else {
          const [cx, cy] = project(this.centre)
          this.centre = unproject(cx - dx / this.scale, cy - dy / this.scale)
          this.settle()
        }
        this.dragging.x = e.offsetX
        this.dragging.y = e.offsetY
        this.draw()
        return
      }
      if (this.mode === 'pick') {
        const w = this.wayAt(e.offsetX, e.offsetY)
        if (w?.id !== this.hovered) {
          this.hovered = w?.id ?? null
          c.style.cursor = w ? 'pointer' : ''
          this.draw()
        }
      }
    })
    c.addEventListener('pointerup', (e) => {
      const drag = this.dragging
      this.dragging = null
      if (!drag || drag.moved) return
      const p = this.toLonLat(e.offsetX, e.offsetY)
      if (this.mode === 'draw') {
        // clicking the first vertex closes the ring, which is the gesture every drawing tool has
        if (this.ring.length >= 3 && this.vertexAt(e.offsetX, e.offsetY) === 0) return this.closeRing()
        this.ring.push(p)
        this.ringClosed = false
        this.o.onBoundary(this.ring, false)
        this.draw()
      } else if (this.mode === 'pick') {
        const w = this.wayAt(e.offsetX, e.offsetY)
        if (w) this.o.onPick(w, e.shiftKey)
      }
    })
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (this.mode !== 'draw' || !this.ring.length) return
      const v = this.vertexAt(e.offsetX, e.offsetY)
      if (v != null) this.ring.splice(v, 1)
      else this.ring.pop()
      this.ringClosed = this.ringClosed && this.ring.length >= 3
      this.o.onBoundary(this.ring, this.ringClosed)
      this.draw()
    })
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        // zoom about the cursor: the point under the pointer stays under the pointer
        this.moved = true
        const before = this.toLonLat(e.offsetX, e.offsetY)
        // Down to 2, not 4: the whole point is that you can start at the world.
        this.zoom = Math.max(2, Math.min(19, this.zoom - Math.sign(e.deltaY) * 0.5))
        const after = this.toLonLat(e.offsetX, e.offsetY)
        const [bx, by] = project(before)
        const [ax, ay] = project(after)
        const [cx, cy] = project(this.centre)
        this.centre = unproject(cx + bx - ax, cy + by - ay)
        this.draw()
        this.settle()
      },
      { passive: false },
    )
  }

  closeRing() {
    if (this.ring.length < 3) return
    this.ringClosed = true
    this.o.onBoundary(this.ring, true)
    this.draw()
  }

  clearRing() {
    this.ring = []
    this.ringClosed = false
    this.o.onBoundary(this.ring, false)
    this.draw()
  }

  private vertexAt(x: number, y: number): number | null {
    for (let i = 0; i < this.ring.length; i++) {
      const [vx, vy] = this.toScreen(this.ring[i])
      if ((vx - x) ** 2 + (vy - y) ** 2 < 100) return i
    }
    return null
  }

  /** The nearest way within 6 px of the point. Squared distance to each segment, no allocation. */
  private wayAt(x: number, y: number): Way | null {
    let best: Way | null = null
    let bestD = 36
    for (const w of this.ways) {
      for (let i = 1; i < w.line.length; i++) {
        const [ax, ay] = this.toScreen({ lon: w.line[i - 1][0], lat: w.line[i - 1][1] })
        const [bx, by] = this.toScreen({ lon: w.line[i][0], lat: w.line[i][1] })
        const d = segDist2(x, y, ax, ay, bx, by)
        if (d < bestD) {
          bestD = d
          best = w
        }
      }
    }
    return best
  }

  /* ---- drawing ----------------------------------------------------------------------------- */

  draw() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  private paint() {
    const g = this.ctx
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const css = getComputedStyle(document.documentElement)
    g.fillStyle = css.getPropertyValue('--bg-0').trim() || '#0d1014'
    g.fillRect(0, 0, this.w, this.h)

    this.paintGraticule(g)
    this.paintBorders(g)
    this.paintMajor(g)
    this.paintOthers(g)
    this.paintWays(g)
    this.paintExtent(g)
    this.paintRing(g)
    this.paintPlaces(g)
    this.paintPins(g)
    this.paintScale(g)
  }

  /** A degree grid, so a featureless area is not a blank screen and a pan has something to hold. */
  private paintGraticule(g: CanvasRenderingContext2D) {
    // Off at the overview: at world zoom the useful grid is the coastlines, and a 25 km lattice
    // over them is just noise.
    if (this.zoom < 7) return
    const mpp = this.metresPerPixel
    const stepM = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000].find((s) => s / mpp > 70) ?? 50000
    const stepDeg = stepM / 111320
    const b = this.bbox()
    g.strokeStyle = 'rgba(128,140,155,0.10)'
    g.lineWidth = 1
    g.beginPath()
    for (let lat = Math.floor(b.south / stepDeg) * stepDeg; lat < b.north + stepDeg; lat += stepDeg) {
      const [, y] = this.toScreen({ lon: b.west, lat })
      g.moveTo(0, Math.round(y) + 0.5)
      g.lineTo(this.w, Math.round(y) + 0.5)
    }
    const stepLon = stepDeg / Math.max(0.05, Math.cos((this.centre.lat * Math.PI) / 180))
    for (let lon = Math.floor(b.west / stepLon) * stepLon; lon < b.east + stepLon; lon += stepLon) {
      const [x] = this.toScreen({ lon, lat: b.north })
      g.moveTo(Math.round(x) + 0.5, 0)
      g.lineTo(Math.round(x) + 0.5, this.h)
    }
    g.stroke()
  }

  /** Is this layer worth drawing at the current zoom? Unknown layers draw, so a new one shows up. */
  inBand(layer: string): boolean {
    const b = this.bands.get(layer)
    return !b || (this.zoom >= b.minZoom && this.zoom < b.maxZoom)
  }

  /** Everything this map holds for a layer, across the tiles it has — empty when out of band. */
  itemsOf<T>(layer: string): T[] {
    if (!this.inBand(layer)) return []
    const out: T[] = []
    for (const t of this.tiles.values()) if (t.layer === layer) out.push(...(t.items as T[]))
    return out
  }

  /**
   * Country outlines: a filled landmass and a hairline border.
   *
   * Filled, not just stroked, because an unfilled outline at world zoom reads as a tangle of
   * squiggles and the thing a person actually needs is "sea there, land here, that shape is Italy".
   */
  private paintBorders(g: CanvasRenderingContext2D) {
    if (!this.borders.length || this.zoom > 9) return
    const fade = this.zoom > 6 ? Math.max(0, 1 - (this.zoom - 6) / 3) : 1
    g.save()
    g.globalAlpha = fade
    g.fillStyle = 'rgba(31,41,51,0.85)'
    g.strokeStyle = 'rgba(122,140,158,0.55)'
    g.lineWidth = 1
    for (const f of this.borders) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]] : (f.geometry.coordinates as number[][][][])
      for (const poly of polys) {
        g.beginPath()
        for (const ring of poly) {
          for (let i = 0; i < ring.length; i++) {
            const [x, y] = this.toScreen({ lon: ring[i][0], lat: ring[i][1] })
            if (i === 0) g.moveTo(x, y)
            else g.lineTo(x, y)
          }
          g.closePath()
        }
        g.fill()
        g.stroke()
      }
    }
    g.restore()
  }

  /** The motorway skeleton. Drawn under the detail roads so a town reads over its bypass. */
  private paintMajor(g: CanvasRenderingContext2D) {
    const lines = this.itemsOf<MajorLine>('major')
    if (!lines.length) return
    g.save()
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const w of lines) {
      const s = styleOf(w.highway)
      g.strokeStyle = s.c
      g.lineWidth = s.w
      g.globalAlpha = 0.9
      g.beginPath()
      for (let i = 0; i < w.line.length; i++) {
        const [x, y] = this.toScreen({ lon: w.line[i][0], lat: w.line[i][1] })
        if (i === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    }
    g.restore()
    if (this.zoom >= 7) this.paintRefs(g, lines)
  }

  /** Motorway numbers — an A4 shield is how you recognise a road you have never driven. */
  private paintRefs(g: CanvasRenderingContext2D, lines: MajorLine[]) {
    const placed = new Set<string>()
    g.save()
    g.font = '600 10px ui-monospace, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const w of lines) {
      const ref = w.ref?.split(';')[0]?.trim()
      if (!ref || placed.has(ref) || w.line.length < 2) continue
      const mid = w.line[Math.floor(w.line.length / 2)]
      const [x, y] = this.toScreen({ lon: mid[0], lat: mid[1] })
      if (x < 20 || x > this.w - 20 || y < 12 || y > this.h - 12) continue
      const width = g.measureText(ref).width + 8
      g.fillStyle = 'rgba(13,16,20,0.85)'
      g.strokeStyle = 'rgba(217,136,79,0.8)'
      g.lineWidth = 1
      g.beginPath()
      g.roundRect(x - width / 2, y - 7, width, 14, 3)
      g.fill()
      g.stroke()
      g.fillStyle = '#d9a441'
      g.fillText(ref, x, y)
      placed.add(ref)
    }
    g.restore()
  }

  /**
   * Cities and towns, as a dot and a label, biggest first with collision rejection.
   *
   * Below the `places` layer's minimum zoom this draws the world-cities basemap instead, so the
   * view never goes from "labelled" to "blank" as you pull out — which is exactly the transition
   * that made the old map feel broken.
   */
  private paintPlaces(g: CanvasRenderingContext2D) {
    const live = this.itemsOf<PlacePoint>('places')
    const source: { name: string; lat: number; lon: number; pop: number; kind?: string }[] = live.length
      ? live
      : this.worldCities
    if (!source.length) return
    const boxes: [number, number, number, number][] = []
    const hits = (x: number, y: number, w: number, h: number) =>
      boxes.some((b) => x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1])
    g.save()
    g.font = '11px var(--font-mono), ui-monospace, monospace'
    g.textBaseline = 'middle'
    g.strokeStyle = 'rgba(13,16,20,0.85)'
    g.lineWidth = 3
    let drawn = 0
    for (const p of source) {
      if (drawn > 120) break
      const [x, y] = this.toScreen({ lon: p.lon, lat: p.lat })
      if (x < 0 || x > this.w || y < 0 || y > this.h) continue
      const major = (p.kind ?? 'city') === 'city' || p.pop > 100000
      const r = major ? 3 : 2
      const label = p.name
      const tw = g.measureText(label).width
      if (hits(x + 6, y - 7, tw + 4, 14)) continue
      boxes.push([x + 6, y - 7, tw + 4, 14])
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fillStyle = major ? '#e6ecf2' : '#a3b1bf'
      g.fill()
      g.fillStyle = major ? '#e6ecf2' : '#a3b1bf'
      g.strokeText(label, x + 6, y)
      g.fillText(label, x + 6, y)
      drawn++
    }
    g.restore()
  }

  private paintWays(g: CanvasRenderingContext2D) {
    if (!this.ways.length || !this.inBand('roads')) return
    g.lineCap = 'round'
    g.lineJoin = 'round'
    // Painted class by class so the motorways land on top of the residentials, which is the one
    // thing that stops a junction reading as a pile of identical lines.
    const order = ['living_street', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway']
    const byClass = new Map<string, Way[]>()
    for (const w of this.ways) {
      const k = order.includes(w.highway) ? w.highway : 'link'
      const a = byClass.get(k)
      if (a) a.push(w)
      else byClass.set(k, [w])
    }
    for (const k of ['link', ...order]) {
      const list = byClass.get(k)
      if (!list) continue
      const s = styleOf(k === 'link' ? 'x_link' : k)
      if (this.zoom < s.minZoom) continue
      for (const w of list) {
        const on = this.picked.has(w.ident)
        g.strokeStyle = on ? '#4aa8e8' : s.c
        g.lineWidth = (on ? s.w + 1.6 : s.w) * (w.id === this.hovered ? 2 : 1)
        g.globalAlpha = on || w.id === this.hovered ? 1 : 0.85
        g.beginPath()
        for (let i = 0; i < w.line.length; i++) {
          const [x, y] = this.toScreen({ lon: w.line[i][0], lat: w.line[i][1] })
          if (i === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }
    }
    g.globalAlpha = 1
    if (this.zoom >= 15) this.paintLabels(g)
  }

  /** Road names, once per ident, on the longest visible segment of it. Cheap and readable. */
  private paintLabels(g: CanvasRenderingContext2D) {
    const placed = new Map<string, number>()
    g.font = '11px var(--font-mono), ui-monospace, monospace'
    g.fillStyle = '#a3b1bf'
    g.strokeStyle = 'rgba(13,16,20,0.8)'
    g.lineWidth = 3
    for (const w of this.ways) {
      if (!w.name) continue
      let bi = -1
      let bl = 0
      for (let i = 1; i < w.line.length; i++) {
        const [ax, ay] = this.toScreen({ lon: w.line[i - 1][0], lat: w.line[i - 1][1] })
        const [bx, by] = this.toScreen({ lon: w.line[i][0], lat: w.line[i][1] })
        const l = Math.hypot(bx - ax, by - ay)
        if (l > bl) {
          bl = l
          bi = i
        }
      }
      if (bi < 0 || bl < 60 || (placed.get(w.name) ?? 0) > 0) continue
      const [ax, ay] = this.toScreen({ lon: w.line[bi - 1][0], lat: w.line[bi - 1][1] })
      const [bx, by] = this.toScreen({ lon: w.line[bi][0], lat: w.line[bi][1] })
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      if (mx < 0 || mx > this.w || my < 0 || my > this.h) continue
      let a = Math.atan2(by - ay, bx - ax)
      if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI // never upside down
      g.save()
      g.translate(mx, my)
      g.rotate(a)
      g.textAlign = 'center'
      g.strokeText(w.name, 0, -4)
      g.fillText(w.name, 0, -4)
      g.restore()
      placed.set(w.name, 1)
    }
  }

  /**
   * The extent, drawn as the CIRCLE and the SQUARE.
   *
   * `radius_m` is a HALF-WIDTH and its name is wrong at the source: `network.roads` queries the
   * geodetic bounding box of a UTM square of side 2·radius_m and never clips to a circle
   * afterwards, so the square is 4/π = 1.27× the area the name implies. The
   * square is drawn solid and labelled "what the bake takes"; the circle is a dashed hint at where
   * the radius came from. Drawing only the circle is how someone ends up believing they excluded a
   * motorway that the bake then chains right through their town.
   */
  private paintExtent(g: CanvasRenderingContext2D) {
    if (!this.extent) return
    const { centre, radius_m } = this.extent
    const mpp = this.metresPerPixel
    const rpx = radius_m / mpp
    const [cx, cy] = this.toScreen(centre)

    g.save()
    g.strokeStyle = '#4aa8e8'
    g.setLineDash([5, 4])
    g.lineWidth = 1
    g.globalAlpha = 0.55
    g.beginPath()
    g.arc(cx, cy, rpx, 0, Math.PI * 2)
    g.stroke()

    g.setLineDash([])
    g.globalAlpha = 1
    g.lineWidth = 1.5
    g.strokeRect(cx - rpx, cy - rpx, rpx * 2, rpx * 2)
    g.fillStyle = 'rgba(74,168,232,0.07)'
    g.fillRect(cx - rpx, cy - rpx, rpx * 2, rpx * 2)

    g.fillStyle = '#4aa8e8'
    g.font = '11px ui-monospace, monospace'
    g.textAlign = 'left'
    g.fillText(`the bake takes this square · ${(radius_m * 2).toLocaleString()} m a side (radius_m is a half-width)`, cx - rpx + 6, cy - rpx - 6)
    g.restore()
  }

  private paintOthers(g: CanvasRenderingContext2D) {
    const mpp = this.metresPerPixel
    g.save()
    for (const o of this.others) {
      const rpx = o.radius_m / mpp
      if (rpx < 6) continue
      const [cx, cy] = this.toScreen(o.centre)
      if (cx + rpx < 0 || cx - rpx > this.w || cy + rpx < 0 || cy - rpx > this.h) continue
      g.strokeStyle = o.baked ? 'rgba(86,185,130,0.5)' : 'rgba(107,122,137,0.45)'
      g.lineWidth = 1
      g.setLineDash(o.baked ? [] : [3, 3])
      g.strokeRect(cx - rpx, cy - rpx, rpx * 2, rpx * 2)
      if (rpx > 28) {
        g.fillStyle = o.baked ? 'rgba(86,185,130,0.85)' : 'rgba(107,122,137,0.8)'
        g.font = '10px ui-monospace, monospace'
        g.textAlign = 'left'
        g.fillText(o.slug, cx - rpx + 4, cy - rpx + 12)
      }
    }
    g.restore()
  }

  private paintRing(g: CanvasRenderingContext2D) {
    if (!this.ring.length) return
    g.save()
    g.strokeStyle = '#d9a441'
    g.fillStyle = 'rgba(217,164,65,0.10)'
    g.lineWidth = 1.5
    g.beginPath()
    for (let i = 0; i < this.ring.length; i++) {
      const [x, y] = this.toScreen(this.ring[i])
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    if (this.ringClosed) {
      g.closePath()
      g.fill()
    }
    g.stroke()
    for (let i = 0; i < this.ring.length; i++) {
      const [x, y] = this.toScreen(this.ring[i])
      g.beginPath()
      g.arc(x, y, i === 0 && !this.ringClosed && this.ring.length >= 3 ? 6 : 4, 0, Math.PI * 2)
      g.fillStyle = i === 0 && !this.ringClosed && this.ring.length >= 3 ? '#56b982' : '#d9a441'
      g.fill()
    }
    g.restore()
  }

  /**
   * Indexed places, at every zoom and over everything.
   *
   * Deliberately not subject to the label collision rules the place layer uses: these are the ones
   * a person chose, so they win. A pin that has become a world is drawn differently, because "have
   * I already done this one" is the question you ask of an index.
   */
  private paintPins(g: CanvasRenderingContext2D) {
    if (!this.pins.length) return
    g.save()
    g.font = '600 11px var(--font-mono), ui-monospace, monospace'
    g.textBaseline = 'middle'
    for (const p of this.pins) {
      const [x, y] = this.toScreen({ lon: p.lon, lat: p.lat })
      if (x < -40 || x > this.w + 40 || y < -20 || y > this.h + 20) continue
      const col = p.world ? '#56b982' : '#d9a441'
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x - 5, y - 11)
      g.lineTo(x + 5, y - 11)
      g.closePath()
      g.fillStyle = col
      g.fill()
      g.beginPath()
      g.arc(x, y - 14, 5, 0, Math.PI * 2)
      g.fillStyle = col
      g.fill()
      g.strokeStyle = 'rgba(13,16,20,0.9)'
      g.lineWidth = 3
      g.strokeText(p.name, x + 9, y - 12)
      g.fillStyle = col
      g.fillText(p.name, x + 9, y - 12)
    }
    g.restore()
  }

  /** A bar whose length is a round number of metres at the map's own latitude. */
  private paintScale(g: CanvasRenderingContext2D) {
    const mpp = this.metresPerPixel
    const target = 120
    // Up to 5 000 km: at zoom 2 a metre is a millionth of the screen and a bar that stops at 50 km
    // is fourteen pixels long, which is not a scale bar, it is a dash.
    const nice = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000]
    const m = nice.find((n) => n / mpp > target) ?? 5000000
    const px = m / mpp
    const x = 14
    const y = this.h - 18
    g.save()
    g.strokeStyle = 'rgba(230,236,242,0.75)'
    g.fillStyle = 'rgba(230,236,242,0.85)'
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(x, y - 5)
    g.lineTo(x, y)
    g.lineTo(x + px, y)
    g.lineTo(x + px, y - 5)
    g.stroke()
    g.font = '11px ui-monospace, monospace'
    g.textAlign = 'left'
    g.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x + 4, y - 8)
    g.restore()
  }
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
  const cx = ax + t * dx
  const cy = ay + t * dy
  return (px - cx) ** 2 + (py - cy) ** 2
}
