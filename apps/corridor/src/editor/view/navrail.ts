// The on-screen half of the navigation: trailworks' control rail.
//
// Trailworks keeps +/− and a compass on screen beside the map (its `globeZoomBy` and the north
// button), because a wheel, a middle button and two fingers are three things a person may not
// have. The buttons do exactly what the keys do: a wheel notch about the screen centre, and the
// ease to north-up. The fourth frames the whole world (`T`). Under them, the scale: ground metres
// per pixel and the pyramid level that is, so "is this z14 yet" is a thing you can read.
import './navrail.css'
import { icon } from '../../ui/icons'
import { el } from '../../ui/shell'
import type { MapNav } from './nav'

export class NavRail {
  readonly root = el('div', 'nav-rail')
  private needle: SVGSVGElement
  private scale = el('div', 'nav-scale')
  private lastRect = ''
  private lastHeading = NaN
  private lastScale = ''
  /** the world's latitude, for the z reading */
  lat = 39

  private nav: MapNav
  private canvas: HTMLCanvasElement

  constructor(nav: MapNav, canvas: HTMLCanvasElement, onFrame: () => void) {
    this.nav = nav
    this.canvas = canvas
    const b = (title: string, child: Node, on: () => void, cls = '') => {
      const btn = el('button', cls)
      btn.type = 'button'
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.append(child)
      btn.onclick = (e) => { e.preventDefault(); on() }
      // the rail is not the map: a press here must not start a drag on the canvas under it
      btn.onpointerdown = (e) => e.stopPropagation()
      return btn
    }
    this.needle = compassSvg()
    this.root.append(
      b('Zoom in (+)', icon('plus', 18), () => nav.zoomBy(-0.6)),
      b('Zoom out (−)', icon('minus', 18), () => nav.zoomBy(0.6)),
      b('North up, look straight down (Home)', this.needle, () => nav.northUp(), 'nav-compass'),
      b('Frame the whole world (T)', icon('arrows-pointing-out', 18), onFrame),
      this.scale,
    )
    canvas.after(this.root)
  }

  /** Once a frame: follow the canvas's box, turn the needle, update the scale. */
  update(shown: boolean): void {
    const hide = !shown || this.canvas.hidden
    if (this.root.hidden !== hide) this.root.hidden = hide
    if (hide) return
    const r = this.canvas.getBoundingClientRect()
    const key = `${r.right}|${r.bottom}`
    if (key !== this.lastRect) {
      this.lastRect = key
      this.root.style.left = ''
      this.root.style.right = `${Math.max(0, innerWidth - r.right) + 12}px`
      this.root.style.bottom = `${Math.max(0, innerHeight - r.bottom) + 12}px`
    }
    const h = Math.round(this.nav.headingDeg)
    if (h !== this.lastHeading) {
      this.lastHeading = h
      this.needle.style.transform = `rotate(${-h}deg)`
    }
    const mpp = this.nav.metresPerPixel
    // the web-mercator level whose 256 px tile has this ground scale at the world's latitude
    // (156 543 m/px at z0 on the equator, times cos φ) — a reading for people who think in z
    const z = Math.log2((156_543 * Math.cos((this.lat * Math.PI) / 180)) / Math.max(mpp, 1e-3))
    const s = `${mpp >= 10 ? Math.round(mpp) : mpp.toFixed(mpp >= 1 ? 1 : 2)} m/px · z${Math.max(0, z).toFixed(0)}`
    if (s !== this.lastScale) {
      this.lastScale = s
      this.scale.textContent = s
    }
  }
}

/** a north needle: red half up, light half down */
function compassSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = '<path d="M12 2.5 L15.2 12 H8.8 Z" fill="#e5484d"/><path d="M12 21.5 L8.8 12 H15.2 Z" fill="currentColor" opacity="0.75"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/>'
  return svg
}
