// Inset top-down map: where you are on the corridor, north-up, drawn on a 2D canvas the way
// trailworks' MapModal does it — imagery underneath, vector linework on top, detail fading as you
// pull out. Sources are the site's own web layers (the 1 m NAIP JPEG) and osm.geojson for the
// roads, so it needs nothing the viewer does not already have.
//
// THE CHROME, after Rich (2026-09-26): "should just be resizable and full screen interaction
// without having to click tiny buttons to dismiss". So:
//
//   drag the corner        resize it — the panel is a plain CSS `resize` box and the canvas
//                          follows it; the scale (px/m) is kept, so a bigger map shows more ground
//   double-click           DROPS THE CAR THERE (2026-09-30); the button, Esc and N do full screen
//   wheel over the map     zoom about the cursor
//   drag                   pan (the map stops following; the locate button or moving re-centres)
//   the marker             the car in drive mode, the camera in fly mode, with its heading
//
// The two buttons are Heroicons like the rest of the interface, not glyphs from whichever font
// the browser had, and the size you drag it to is remembered in this browser.
import { DATA_BASE, type Manifest } from '../../world/site'
import { button } from '../../ui/shell'

interface Road {
  pts: Float32Array // site x,y pairs
  cls: string
  name?: string
}

const CLASS_STYLE: Record<string, { w: number; c: string; minPxPerM: number }> = {
  motorway: { w: 4, c: '#ffb648', minPxPerM: 0 },
  trunk: { w: 3.5, c: '#ffd07a', minPxPerM: 0 },
  primary: { w: 3, c: '#ffe8a8', minPxPerM: 0 },
  secondary: { w: 2.5, c: '#ffffff', minPxPerM: 0.02 },
  tertiary: { w: 2, c: '#e6e6e6', minPxPerM: 0.05 },
  motorway_link: { w: 2, c: '#ffb648', minPxPerM: 0.05 },
  residential: { w: 1.5, c: '#c9c9c9', minPxPerM: 0.12 },
  unclassified: { w: 1.5, c: '#c9c9c9', minPxPerM: 0.12 },
  service: { w: 1, c: '#9a9a9a', minPxPerM: 0.3 },
  track: { w: 1, c: '#8a7a5a', minPxPerM: 0.3 },
  railway: { w: 2, c: '#7a5aa0', minPxPerM: 0.02 },
  waterway: { w: 1.5, c: '#5a8ad0', minPxPerM: 0.05 },
}

const SIZE_KEY = 'apex-corridor-minimap-size'
const MIN = 160
const DEFAULT = 240

export class MiniMap {
  el: HTMLElement
  private canvas: HTMLCanvasElement
  /** a program may hide the map (`api.hide('minimap')`) */
  show(on: boolean): void {
    this.el.style.display = on ? '' : 'none'
  }
  private ctx: CanvasRenderingContext2D
  private imagery: HTMLImageElement | null = null
  private imgBbox: [number, number, number, number] | null = null
  /**
   * WHERE THE PHOTOGRAPH REALLY SITS: its three corners in PLAN metres, not its bounding box.
   *
   * The NAIP overview's own grid is UTM zone 18N, and UTM grid north is 1.06 degrees off true
   * north here (`frame.utm_convergence_deg`). The vectors go through the ENU projector, which is
   * true north and right. Stamping the photo into `layers.naip.bbox` therefore drew it rotated
   * back by that angle — and, because an axis-aligned bounding box of a rotated rectangle is
   * bigger than the rectangle, stretched by 1.7 per cent east and 2.0 per cent north as well.
   *
   * Measured across the 81 control points: zero at the site centre, growing linearly to 158 m at
   * the corners, and 64 m almost due east where Rich was parked — "the rendered vectors drifting
   * from the sat imagery, this time mostly horizontally" (2026-09-27). A least-squares affine fit
   * left 6 cm, so the residual really was just the rotation and the stretch.
   *
   * The three corners give the affine the canvas needs; `layers.naip.geo` is the lattice the bake
   * wrote for exactly this purpose, and the 3D world has been using it all along (RasterFrame).
   */
  private imgQuad: { tl: [number, number]; tr: [number, number]; bl: [number, number] } | null = null
  private roads: Road[] = []
  private spine: Float32Array
  private siblings: Float32Array[]
  private pxPerM = 0.25 // zoom
  private centre = { x: 0, y: 0 } // site frame
  private follow = true
  /** the map turns with the car so ahead is up */
  private headingUp = false
  private targets: { x: number; y: number; kind: string }[] = []
  /** the one place the edge arrow points at, when it is off the map */
  private goal: { x: number; y: number } | null = null
  private w = DEFAULT
  private h = DEFAULT
  private dragging = false
  private moved = 0
  private lastX = 0
  private lastY = 0
  private manifest: Manifest
  private frameCount = 0
  private expandBtn: HTMLButtonElement
  private grip: HTMLDivElement
  private ro: ResizeObserver
  private onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.expanded) this.setExpanded(false) }
  /** the ratio the backing store was built for, so a change can be noticed */
  private dpr = 1
  private dprQuery: MediaQueryList | null = null
  expanded = false
  /** full-screen is a player setting, off until they turn it on */
  private expansionEnabled = false
  /**
   * A DOUBLE-CLICK DROPS THE CAR THERE. Rich, 2026-09-30: "Double clicking a spot on the break
   * out map should drop your car there instead of enlarging or shrinking the map (there is a
   * button for it, escape can also do that)". Site metres, x east, y north — the inverse of
   * `toPx`. Unset, or refused by `teleportAllowed`, and a double-click does nothing at all: the
   * button, N and Escape still grow and shrink the map.
   */
  onTeleport: ((x: number, y: number) => void) | null = null
  teleportAllowed: () => boolean = () => true

  /** the site point under a screen position — the inverse of `toPx` */
  siteAt(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const px = clientX - r.left - this.w / 2, py = clientY - r.top - this.h / 2
    return { x: this.centre.x + px / this.pxPerM, y: this.centre.y - py / this.pxPerM }
  }

  constructor(parent: HTMLElement, manifest: Manifest) {
    this.manifest = manifest
    this.el = document.createElement('div')
    this.el.id = 'minimap'
    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d')!
    const locate = button({ icon: 'viewfinder-circle', variant: 'ghost', title: 'follow the car / camera again', onClick: () => { this.follow = true; this.draw(null) } })
    locate.classList.add('mm-locate')
    this.expandBtn = button({ icon: 'arrows-pointing-out', variant: 'ghost', title: 'the whole screen — double-click the map to drive there', key: 'N', onClick: () => this.setExpanded(!this.expanded) })
    this.expandBtn.classList.add('mm-expand')
    this.expandBtn.hidden = true
    // THE GRIP IS AT THE TOP-LEFT. The panel is pinned to the bottom-right corner of the screen,
    // so the browser's own `resize: both` handle — always bottom-right — grew the map INTO the
    // corner it is anchored to: you drag down-right and the map grows up-left, which is backwards
    // (Rich, 2026-09-26). This one is where the map's free corner actually is.
    this.grip = document.createElement('div')
    this.grip.className = 'mm-grip'
    this.grip.title = 'drag to resize'
    this.grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (this.expanded) return
      this.grip.setPointerCapture(e.pointerId)
      const x0 = e.clientX, y0 = e.clientY, w0 = this.w, h0 = this.h
      const maxW = innerWidth - 24, maxH = innerHeight - 72
      const move = (m: PointerEvent) => {
        this.w = Math.round(Math.min(maxW, Math.max(MIN, w0 - (m.clientX - x0))))
        this.h = Math.round(Math.min(maxH, Math.max(MIN, h0 - (m.clientY - y0))))
        this.el.style.width = `${this.w}px`
        this.el.style.height = `${this.h}px`
        this.fit()
        this.draw(null)
      }
      const up = () => {
        this.grip.removeEventListener('pointermove', move)
        this.grip.removeEventListener('pointerup', up)
        try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: this.w, h: this.h })) } catch { /* private window */ }
      }
      this.grip.addEventListener('pointermove', move)
      this.grip.addEventListener('pointerup', up)
    })
    this.el.append(this.canvas, locate, this.expandBtn, this.grip)
    parent.append(this.el)
    this.spine = new Float32Array(manifest.spine.coords.flatMap(([x, y]) => [x, y]))
    this.siblings = manifest.siblings.map((s) => new Float32Array(s.flatMap(([x, y]) => [x, y])))

    // the remembered size, then let the CSS resize handle change it from there
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as { w: number; h: number } | null
      if (saved && saved.w >= MIN && saved.h >= MIN) { this.w = saved.w; this.h = saved.h }
    } catch { /* fresh browser */ }
    this.el.style.width = `${this.w}px`
    this.el.style.height = `${this.h}px`
    this.fit()
    // the canvas follows whatever the panel was dragged to
    this.ro = new ResizeObserver(() => {
      if (this.expanded) return
      const r = this.el.getBoundingClientRect()
      if (Math.abs(r.width - this.w) < 1 && Math.abs(r.height - this.h) < 1) return
      this.w = Math.max(MIN, Math.round(r.width))
      this.h = Math.max(MIN, Math.round(r.height))
      try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: this.w, h: this.h })) } catch { /* private window */ }
      this.fit()
      this.draw(null)
    })
    this.ro.observe(this.el)
    this.watchScale()

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * 0.0015)
      // zoom about the cursor: keep the site point under the cursor fixed
      const r = this.canvas.getBoundingClientRect()
      const px = e.clientX - r.left - this.w / 2, py = e.clientY - r.top - this.h / 2
      const sx = this.centre.x + px / this.pxPerM, sy = this.centre.y - py / this.pxPerM
      this.pxPerM = Math.min(4, Math.max(0.02, this.pxPerM * f))
      this.centre.x = sx - px / this.pxPerM
      this.centre.y = sy + py / this.pxPerM
      this.follow = false
      this.draw(null)
    }, { passive: false })
    this.canvas.addEventListener('pointerdown', (e) => { this.dragging = true; this.moved = 0; this.lastX = e.clientX; this.lastY = e.clientY; e.stopPropagation() })
    addEventListener('pointerup', () => (this.dragging = false))
    addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      this.moved += Math.abs(e.clientX - this.lastX) + Math.abs(e.clientY - this.lastY)
      this.centre.x -= (e.clientX - this.lastX) / this.pxPerM
      this.centre.y += (e.clientY - this.lastY) / this.pxPerM
      this.lastX = e.clientX
      this.lastY = e.clientY
      this.follow = false
      this.draw(null)
    })
    // double-click puts the car where you pointed; the button, N and Escape do big/small
    this.canvas.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (!this.onTeleport || !this.teleportAllowed()) return
      const p = this.siteAt(e.clientX, e.clientY)
      this.onTeleport(p.x, p.y)
    })
    addEventListener('keydown', this.onKey)
    void this.load()
  }

  /** the backing store follows the CSS size and the device pixel ratio */
  private fit() {
    const dpr = devicePixelRatio
    this.dpr = dpr
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.canvas.style.width = `${this.w}px`
    this.canvas.style.height = `${this.h}px`
  }

  /**
   * Re-fit when the DEVICE PIXEL RATIO changes, which is what browser zoom is.
   *
   * Rich, 2026-09-29, with two screenshots: *"mini map does weird things when the browser zoom level
   * changes"*. It did, and the `ResizeObserver` above could not catch it: zooming the browser leaves
   * the panel exactly 240 CSS pixels wide, so the observer's own early-out — "the box has not
   * changed, nothing to do" — was right about the box and wrong about the canvas. The backing store
   * stayed at the old ratio and the browser resampled it: a smeared map, a rim that no longer met
   * the rounded frame, and the scale bar drawn at a size the panel was not.
   *
   * A media query on the ratio is the way to hear about it — there is no `dprchange` event — and it
   * has to be RE-ARMED after each change, because the query itself names the old value and can
   * never match again.
   */
  private watchScale() {
    const rearm = () => {
      this.dprQuery?.removeEventListener('change', onChange)
      this.dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
      this.dprQuery.addEventListener('change', onChange, { once: true })
    }
    const onChange = () => {
      this.rescale()
      rearm()
    }
    rearm()
    // belt and braces: some browsers fire a resize for a zoom and some do not
    addEventListener('resize', this.onResize)
  }

  private onResize = () => this.rescale()

  /** Re-fit and redraw if the ratio moved. Cheap, and a no-op the rest of the time. */
  private rescale() {
    if (devicePixelRatio === this.dpr) return
    this.fit()
    this.draw(null)
  }

  /**
   * The raster's own corners, in plan metres, from its geodetic control lattice.
   *
   * Rows run SOUTH-to-north in these bakes (row 0 is the southern edge) while an image's first
   * pixel row is its TOP, so the image's top-left is the lattice's LAST row, first column. Null
   * for a bake made before the lattice existed, and then the bounding box is all there is.
   */
  private quadOf(L: { geo?: { n: number; lon: number[]; lat: number[] } }): { tl: [number, number]; tr: [number, number]; bl: [number, number] } | null {
    const g = L.geo
    if (!g || !g.n || !g.lon || !g.lat) return null
    const fr = this.manifest.frame as { epsg: number; origin: [number, number]; kind?: string; anchor?: { lon: number; lat: number; h?: number } }
    const proj = siteProjector(fr)
    const n = g.n
    const at = (r: number, c: number): [number, number] => proj(g.lon[r * n + c], g.lat[r * n + c])
    // which row is north? ask the lattice rather than remember
    const northIsLastRow = g.lat[(n - 1) * n] > g.lat[0]
    const top = northIsLastRow ? n - 1 : 0
    const bot = northIsLastRow ? 0 : n - 1
    return { tl: at(top, 0), tr: at(top, n - 1), bl: at(bot, 0) }
  }

  /**
   * How far the photograph is from the linework, in metres, at the bake's own control points.
   *
   * Measured through the SAME quad `draw` uses, so it cannot pass while the drawing is wrong.
   * Returns null until the image has loaded.
   */
  registration(): { points: number; maxM: number; meanM: number; worst: [number, number] } | null {
    const L = this.manifest.layers.naip as { geo?: { n: number; lon: number[]; lat: number[] } } | undefined
    const g = L?.geo
    const q = this.imgQuad
    if (!g || !q || !this.imagery) return null
    const fr = this.manifest.frame as Parameters<typeof siteProjector>[0]
    const proj = siteProjector(fr)
    const n = g.n
    const northIsLastRow = g.lat[(n - 1) * n] > g.lat[0]
    let max = 0
    let sum = 0
    let worst: [number, number] = [0, 0]
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // where this control point sits in IMAGE pixels, then through the quad into plan metres
        const u = c / (n - 1)
        const v = (northIsLastRow ? n - 1 - r : r) / (n - 1)
        const px = q.tl[0] + u * (q.tr[0] - q.tl[0]) + v * (q.bl[0] - q.tl[0])
        const py = q.tl[1] + u * (q.tr[1] - q.tl[1]) + v * (q.bl[1] - q.tl[1])
        const [tx, ty] = proj(g.lon[r * n + c], g.lat[r * n + c])
        const d = Math.hypot(px - tx, py - ty)
        sum += d
        if (d > max) { max = d; worst = [+(px - tx).toFixed(2), +(py - ty).toFixed(2)] }
      }
    }
    return { points: n * n, maxM: +max.toFixed(2), meanM: +(sum / (n * n)).toFixed(2), worst }
  }

  private async load() {
    const L = this.manifest.layers.naip
    if (L) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        this.imagery = img
        this.imgBbox = L.bbox
        this.imgQuad = this.quadOf(L)
        this.draw(null)
      }
      img.src = `${DATA_BASE}/sites/${this.manifest.slug}/web/${L.file}`
    }
    try {
      // context.json is the bake's compact projection of osm.geojson: class + coords only, tens of
      // kB instead of 389 MB. Fall back to the raw extract for sites baked before it existed.
      const fr = this.manifest.frame as { epsg: number; origin: [number, number]; kind?: string; anchor?: { lon: number; lat: number; h?: number } }
      // WHICH METRES does this manifest hold? `frame.kind` is the only thing that says, and
      // guessing wrong rotates the overlay by the grid convergence — measured 12 m mean and 30 m
      // worst against the ENU bakes, which looks exactly like the imagery offset Rich chased for
      // hours. ENU is true north about the site anchor; the old bakes are UTM minus the origin.
      const proj = fr.kind === 'enu' && fr.anchor ? enuProjector(fr.anchor.lon, fr.anchor.lat, fr.anchor.h ?? 0) : utmProjector(fr.epsg, fr.origin[0], fr.origin[1])
      const push = (coords: number[][], cls: string, name?: string) => {
        const pts = new Float32Array(coords.length * 2)
        coords.forEach(([lon, lat], i) => {
          const [x, y] = proj(lon, lat)
          pts[i * 2] = x
          pts[i * 2 + 1] = y
        })
        this.roads.push({ pts, cls, name })
      }
      const rc = await fetch(`${DATA_BASE}/sites/${this.manifest.slug}/context.json`, { cache: 'force-cache' })
      if (rc.ok) {
        const ctx = (await rc.json()) as { roads?: { cls: string; name?: string | null; coords: number[][] }[] }
        for (const rd of ctx.roads ?? []) {
          if (!(rd.cls in CLASS_STYLE)) continue
          push(rd.coords, rd.cls, rd.name ?? undefined)
        }
        this.draw(null)
        return
      }
      const r = await fetch(`${DATA_BASE}/sites/${this.manifest.slug}/osm.geojson`, { cache: 'force-cache' })
      if (!r.ok) return
      const gj = (await r.json()) as { features: { geometry: { type: string; coordinates: number[][] }; properties: Record<string, string> }[] }
      // osm.geojson is WGS84; project with the site's frame. The manifest gives the origin in UTM;
      // a local equirectangular fit is accurate to well under a metre over a 6 km corridor.
      for (const f of gj.features) {
        if (f.geometry.type !== 'LineString') continue
        const p = f.properties
        const cls = p.highway ?? (p.railway ? 'railway' : p.waterway ? 'waterway' : null)
        if (!cls || !(cls in CLASS_STYLE)) continue
        push(f.geometry.coordinates, cls, p.name ?? p.ref)
      }
      this.draw(null)
    } catch {
      /* no roads layer */
    }
  }

  /** Ahead is up, instead of north. The chevron then points at the top of the map. */
  setHeadingUp(on: boolean): void {
    this.headingUp = on
  }

  /** Race starts, checkpoints, finishes, and the posts a program put down. `goal` is the one to chase. */
  setTargets(list: { x: number; y: number; kind: string }[], goal: { x: number; y: number } | null): void {
    this.targets = list
    this.goal = goal
  }

  /** Draw with the marker at site x,y heading `yaw` (radians, 0 = east, counter-clockwise). */
  draw(marker: { x: number; y: number; yaw: number } | null) {
    if (marker && this.follow) {
      this.centre.x = marker.x
      this.centre.y = marker.y
    }
    // redraw at most every other frame; the map is small but the imagery blit is not free
    if (marker && ++this.frameCount % 2) return
    const ctx = this.ctx, W = this.w, H = this.h, dpr = devicePixelRatio
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.beginPath()
    // round in the corner, a rounded rectangle when it has been stretched or filled
    if (!this.expanded && Math.abs(W - H) < 2) ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2)
    else ctx.roundRect(1, 1, W - 2, H - 2, this.expanded ? 0 : 11)
    ctx.clip()
    ctx.fillStyle = '#1b2a1f'
    ctx.fillRect(0, 0, W, H)
    if (this.headingUp && marker) {
      ctx.translate(W / 2, H / 2)
      ctx.rotate(marker.yaw - Math.PI / 2)
      ctx.translate(-W / 2, -H / 2)
    }
    const toPx = (x: number, y: number): [number, number] => [W / 2 + (x - this.centre.x) * this.pxPerM, H / 2 - (y - this.centre.y) * this.pxPerM]
    if (this.imagery && this.imgQuad) {
      // The photo is a ROTATED rectangle in this frame, and `drawImage` only draws upright ones —
      // so the transform does the rotating. Its columns are the image's own u and v axes, in
      // canvas pixels, and its offset is where pixel (0, 0) goes.
      const q = this.imgQuad
      const tl = toPx(q.tl[0], q.tl[1])
      const tr = toPx(q.tr[0], q.tr[1])
      const bl = toPx(q.bl[0], q.bl[1])
      const iw = this.imagery.width || 1
      const ih = this.imagery.height || 1
      ctx.save()
      ctx.globalAlpha = 0.85
      ctx.transform((tr[0] - tl[0]) / iw, (tr[1] - tl[1]) / iw, (bl[0] - tl[0]) / ih, (bl[1] - tl[1]) / ih, tl[0], tl[1])
      ctx.drawImage(this.imagery, 0, 0)
      ctx.restore()
      ctx.globalAlpha = 1
    } else if (this.imagery && this.imgBbox) {
      // a bake from before the geodetic lattice: the bounding box is all there is
      const [x0, y0, x1, y1] = this.imgBbox
      const [px0, py1] = toPx(x0, y0)
      const [px1, py0] = toPx(x1, y1)
      ctx.globalAlpha = 0.85
      ctx.drawImage(this.imagery, px0, py0, px1 - px0, py1 - py0)
      ctx.globalAlpha = 1
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const r of this.roads) {
      const st = CLASS_STYLE[r.cls]
      if (this.pxPerM < st.minPxPerM) continue // detail fades with zoom
      ctx.strokeStyle = st.c
      ctx.lineWidth = st.w
      this.stroke(r.pts, toPx)
    }
    // our carriageways
    ctx.strokeStyle = '#ffdc00'
    ctx.lineWidth = 3
    this.stroke(this.spine, toPx)
    ctx.strokeStyle = '#ff8c00'
    ctx.lineWidth = 2
    for (const s of this.siblings) this.stroke(s, toPx)
    const DOT: Record<string, string> = { start: '#4fc3f7', finish: '#ff8a65', checkpoint: '#b39ddb', pickup: '#81c784', dropoff: '#ffb74d', goal: '#fff176', home: '#ffd54f' }
    for (const t of this.targets) {
      const [tx, ty] = toPx(t.x, t.y)
      ctx.fillStyle = DOT[t.kind] ?? '#fff'
      ctx.beginPath()
      ctx.arc(tx, ty, 4, 0, Math.PI * 2)
      ctx.fill()
    }
    // marker: a chevron along the heading
    if (marker) {
      const [mx, my] = toPx(marker.x, marker.y)
      ctx.save()
      ctx.translate(mx, my)
      ctx.rotate(-marker.yaw + Math.PI / 2) // yaw is counter-clockwise from east; canvas y is down
      ctx.fillStyle = '#ff3b30'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(0, -9)
      ctx.lineTo(6, 7)
      ctx.lineTo(0, 3)
      ctx.lineTo(-6, 7)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
    this.edgeArrow(marker, W, H)
    // rim, north arrow, scale
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.lineWidth = 1
    ctx.beginPath()
    if (!this.expanded && Math.abs(W - H) < 2) ctx.arc(W / 2, H / 2, W / 2 - 1, 0, Math.PI * 2)
    else ctx.roundRect(1, 1, W - 2, H - 2, this.expanded ? 0 : 11)
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px "IBM Plex Sans", system-ui'
    ctx.textAlign = 'center'
    if (!this.headingUp) ctx.fillText('N', W / 2, 14)
    const barM = niceScale(60 / this.pxPerM)
    const barPx = barM * this.pxPerM
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(W / 2 - barPx / 2, H - 14, barPx, 2)
    ctx.font = '10px "IBM Plex Sans", system-ui'
    ctx.fillText(barM >= 1000 ? `${barM / 1000} km` : `${barM} m`, W / 2, H - 18)
  }

  /**
   * The whole screen or the corner. The scale (px/m) is kept, so expanding shows more ground
   * rather than a blown-up thumbnail; the corner size you dragged to is kept for when it shrinks.
   */
  /** The Expand the map setting. Off hides the button and will not grow the map. */
  setExpansionEnabled(on: boolean): void {
    this.expansionEnabled = on
    this.expandBtn.hidden = !on
    if (!on && this.expanded) this.setExpanded(false)
  }

  setExpanded(on: boolean) {
    if (on && !this.expansionEnabled) return
    if (on === this.expanded) return
    this.expanded = on
    this.el.classList.toggle('expanded', on)
    if (on) {
      this.el.style.width = this.el.style.height = ''
      this.w = innerWidth
      this.h = innerHeight
      this.pxPerM = Math.max(this.pxPerM, 0.12)
    } else {
      this.el.style.width = `${this.w = Math.max(MIN, this.w)}px`
      this.el.style.height = `${this.h = Math.max(MIN, this.h)}px`
      try {
        const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as { w: number; h: number } | null
        if (saved) { this.w = saved.w; this.h = saved.h; this.el.style.width = `${this.w}px`; this.el.style.height = `${this.h}px` }
      } catch { /* keep what we have */ }
    }
    // full screen closes with an X in the corner a person looks for it, not a small glyph at the
    // bottom (Rich, 2026-09-26). Esc, N and a double-click still work.
    this.expandBtn.replaceChildren()
    this.expandBtn.append(iconOf(on ? 'x-mark' : 'arrows-pointing-out'))
    if (on) {
      const label = document.createElement('span')
      label.className = 'mm-close-label'
      label.textContent = 'Close map'
      this.expandBtn.append(label)
    }
    this.expandBtn.title = on ? 'close the map (N, Esc, or left stick)' : 'the whole screen (N) — double-click the map to drive there'
    this.fit()
    this.draw(null)
  }

  /** A tick on the rim toward the goal, when that goal is outside the map. */
  private edgeArrow(marker: { x: number; y: number; yaw: number } | null, W: number, H: number): void {
    const g = this.goal
    if (!g) return
    let px = W / 2 + (g.x - this.centre.x) * this.pxPerM
    let py = H / 2 - (g.y - this.centre.y) * this.pxPerM
    if (this.headingUp && marker) {
      const a = marker.yaw - Math.PI / 2
      const dx = px - W / 2
      const dy = py - H / 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      px = W / 2 + dx * c - dy * s
      py = H / 2 + dx * s + dy * c
    }
    const dx = px - W / 2
    const dy = py - H / 2
    const r = Math.min(W, H) / 2 - 18
    if (dx * dx + dy * dy < r * r) return
    const len = Math.hypot(dx, dy) || 1
    const ex = W / 2 + (dx / len) * r
    const ey = H / 2 + (dy / len) * r
    const ctx = this.ctx
    ctx.save()
    ctx.translate(ex, ey)
    ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2)
    ctx.fillStyle = '#fff176'
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.lineTo(6, 6)
    ctx.lineTo(-6, 6)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  private stroke(pts: Float32Array, toPx: (x: number, y: number) => [number, number]) {
    const ctx = this.ctx
    ctx.beginPath()
    for (let i = 0; i < pts.length; i += 2) {
      const [px, py] = toPx(pts[i], pts[i + 1])
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
  }

  dispose() {
    this.ro.disconnect()
    removeEventListener('keydown', this.onKey)
    removeEventListener('resize', this.onResize)
    this.dprQuery = null
    this.el.remove()
  }
}

import { icon as iconOf } from '../../ui/icons'

function niceScale(m: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(m)))
  const n = m / p
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p
}

/**
 * WGS84 → local east/north metres about the site anchor (the `enu` frame), through ECEF.
 *
 * Exact, not a rotation of the UTM grid: verified against the baked spines at 0.6-0.7 m mean,
 * which is OSM's own digitising accuracy.
 */
export function enuProjector(lon0: number, lat0: number, h0: number): (lon: number, lat: number) => [number, number] {
  const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F)
  const D = Math.PI / 180
  const ecef = (lon: number, lat: number, h: number): [number, number, number] => {
    const lo = lon * D, la = lat * D
    const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2)
    return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)]
  }
  const [x0, y0, z0] = ecef(lon0, lat0, h0)
  const lo0 = lon0 * D, la0 = lat0 * D
  const sLo = Math.sin(lo0), cLo = Math.cos(lo0), sLa = Math.sin(la0), cLa = Math.cos(la0)
  return (lon, lat) => {
    const [x, y, z] = ecef(lon, lat, 0)
    const dx = x - x0, dy = y - y0, dz = z - z0
    return [-sLo * dx + cLo * dy, -sLa * cLo * dx - sLa * sLo * dy + cLa * dz]
  }
}

/**
 * WGS84 → site frame (UTM easting/northing minus the origin). A compact transverse-Mercator
 * forward formula (Krüger series, good to mm), because osm.geojson is the only layer the viewer
 * reads that is not already in metres.
 */
export function utmProjector(epsg: number, ox: number, oy: number): (lon: number, lat: number) => [number, number] {
  const zone = epsg % 100
  const south = Math.floor(epsg / 100) === 327
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180)
  const a = 6378137, f = 1 / 298.257223563
  const n = f / (2 - f), A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64)
  const alpha = [n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3, (13 / 48) * n ** 2 - (3 / 5) * n ** 3, (61 / 240) * n ** 3]
  const k0 = 0.9996, E0 = 500000, N0 = south ? 10000000 : 0
  return (lon, lat) => {
    const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180 - lon0
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - ((2 * Math.sqrt(n)) / (1 + n)) * Math.atanh(((2 * Math.sqrt(n)) / (1 + n)) * Math.sin(phi)))
    const xi = Math.atan(t / Math.cos(lam)), eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t))
    let E = eta, N = xi
    for (let j = 1; j <= 3; j++) {
      E += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
      N += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    }
    return [E0 + k0 * A * E - ox, N0 + k0 * A * N - oy]
  }
}

/** WGS84 → this site's metres, whichever frame the manifest holds — see the note in `load()`. */
export function siteProjector(frame: { epsg: number; origin: [number, number]; kind?: string; anchor?: { lon: number; lat: number; h?: number } }): (lon: number, lat: number) => [number, number] {
  return frame.kind === 'enu' && frame.anchor ? enuProjector(frame.anchor.lon, frame.anchor.lat, frame.anchor.h ?? 0) : utmProjector(frame.epsg, frame.origin[0], frame.origin[1])
}
