// The arcade HUD, drawn inside the low-res buffer.
//
// The DOM overlay is crisp at any window size, which is right for the modern
// look but wrong for the retro one: on a real board the score and the clock
// were pixels in the same framebuffer as the road. This paints them onto a
// canvas at the logical resolution (320×224 and friends) and hangs it in the
// scene, so they go through the same nearest-neighbour upscale, scanlines and
// posterisation as everything else — chunky, aliased, OutRun.

import { CanvasTexture, Mesh, MeshBasicMaterial, NearestFilter, PlaneGeometry } from 'three'
import type { Snapshot } from '../sim/Snapshot'

/** Redraws per second: the clock only ticks, so there is no reason to repaint every frame. */
const REPAINT_HZ = 12

export class HudLayer {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private w = 320
  private h = 224
  private acc = 0
  private message = ''
  private messageClass = ''
  private messageTimer = 0
  private messageLength = 0
  private station = ''
  private clock = 0
  units: 'kmh' | 'mph' = 'kmh'
  /** Hide the speed block in the cockpit view, where the dashboard shows it. */
  cockpit = false
  /** Key or pad labels for the manual switches, so you can see what works them. */
  private switchKeys = { wipers: '', lights: '' }
  /** A switch you should have on right now: it blinks until you do. */
  private needs = { wipers: false, lights: false }
  private viewHint = ''

  constructor() {
    this.canvas.width = this.w
    this.canvas.height = this.h
    this.ctx = this.canvas.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.tex.minFilter = this.tex.magFilter = NearestFilter
    this.tex.generateMipmaps = false
    this.mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false }))
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  /** Match the logical buffer: one canvas pixel per game pixel. */
  layout(width: number, height: number): void {
    const w = Math.max(64, Math.round(width))
    const h = Math.max(64, Math.round(height))
    if (w !== this.w || h !== this.h) {
      this.w = w
      this.h = h
      this.canvas.width = w
      this.canvas.height = h
      this.acc = REPAINT_HZ // force a repaint
    }
    this.mesh.scale.set(w, h, 1)
    this.mesh.position.set(w / 2, h / 2, 0)
  }

  showMessage(text: string, seconds: number, cls = ''): void {
    this.message = text
    this.messageClass = cls
    this.messageTimer = seconds
    this.messageLength = seconds
    this.acc = REPAINT_HZ
  }

  setStation(name: string): void {
    this.station = name
    this.acc = REPAINT_HZ
  }

  setSwitchLabels(wipers: string, lights: string): void {
    if (wipers === this.switchKeys.wipers && lights === this.switchKeys.lights) return
    this.switchKeys = { wipers, lights }
    this.acc = REPAINT_HZ
  }

  setSwitchNeeds(wipers: boolean, lights: boolean): void {
    this.needs = { wipers, lights }
  }

  setViewHint(text: string): void {
    if (text === this.viewHint) return
    this.viewHint = text
    this.acc = REPAINT_HZ
  }

  update(snap: Snapshot, dt: number): void {
    this.clock += dt
    if (this.messageTimer > 0) {
      this.messageTimer -= dt
      if (this.messageTimer <= 0) this.acc = REPAINT_HZ
    }
    this.acc += dt * REPAINT_HZ
    if (this.acc < 1) return
    this.acc = 0
    this.paint(snap)
    this.tex.needsUpdate = true
  }

  private paint(snap: Snapshot): void {
    const c = this.ctx
    const W = this.w
    const H = this.h
    const px = H / 224 // the board's own scale: everything is authored for 224 lines
    c.clearRect(0, 0, W, H)
    c.textBaseline = 'alphabetic'
    const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
      c.font = `${Math.round(6 * px)}px "Press Start 2P", monospace`
      c.textAlign = align
      c.fillStyle = '#3a1208'
      c.fillText(text, x + px, y + px)
      c.fillStyle = '#ffe27a'
      c.fillText(text, x, y)
    }
    const value = (text: string, x: number, y: number, size: number, align: CanvasTextAlign, colour = '#ffd93a') => {
      c.font = `${Math.round(size * px)}px "Racing Sans One", "Arial Black", sans-serif`
      c.textAlign = align
      c.lineJoin = 'round'
      c.strokeStyle = '#3a1208'
      c.lineWidth = Math.max(2, 2.5 * px)
      c.strokeText(text, x, y)
      c.fillStyle = colour
      c.fillText(text, x, y)
    }
    // A title-safe inset: the tube's curve eats a few lines at every edge, so nothing important
    // goes right up against it (the same reason arcade boards kept the score inboard).
    const safe = 18 * px
    // The tube crops more off the bottom than the sides, so the bottom row sits further in.
    const safeB = 32 * px
    label('SCORE', safe, safe + 8 * px, 'left')
    value(snap.hud.score.toLocaleString(), safe, safe + 25 * px, 14, 'left')
    const low = snap.hud.time < 10
    value(String(Math.ceil(snap.hud.time)), W / 2, safe + 30 * px, 28, 'center', snap.hud.checkpointFlash > 0 ? '#7dff9a' : low ? '#ff3b5c' : '#ffd93a')
    label('STAGE', W - safe, safe + 8 * px, 'right')
    value(`${snap.hud.stage}/${snap.hud.stagesTotal}`, W - safe, safe + 25 * px, 14, 'right')
    // Speed, bottom right: the number, its unit beneath, the gear alongside.
    if (!this.cockpit) {
      const shown = this.units === 'kmh' ? snap.hud.speedKmh : snap.hud.speedKmh / 1.609
      value(String(Math.round(shown)), W - safe, H - safeB - 11 * px, 24, 'right')
      label(this.units === 'kmh' ? 'KM/H' : 'MPH', W - safe, H - safeB, 'right')
      value(snap.hud.gear === 1 ? 'HI' : 'LO', W - safe - 54 * px, H - safeB - 11 * px, 12, 'right', '#ff8a3c')
    }
    // Turbo: a chunky segmented bar, above the speed (or bottom right in the cockpit, where the
    // dashboard has the numbers but not this).
    {
      const bw = Math.round(62 * px)
      const bh = Math.max(3, Math.round(5 * px))
      const bx = Math.round(W - safe - bw)
      const by = Math.round(H - safeB - (this.cockpit ? 4 : 38) * px)
      c.fillStyle = 'rgba(20,6,0,0.7)'
      c.fillRect(bx - px, by - px, bw + 2 * px, bh + 2 * px)
      c.fillStyle = 'rgba(232,246,255,0.18)'
      c.fillRect(bx, by, bw, bh)
      const segs = 10
      const lit = Math.round(Math.max(0, Math.min(1, snap.hud.turbo)) * segs)
      const gap = Math.max(1, Math.round(px))
      const sw = (bw - gap * (segs - 1)) / segs
      c.fillStyle = snap.hud.turboActive ? (Math.floor(this.clock * 8) % 2 ? '#fff2a0' : '#ff8a3c') : '#3ce0ff'
      for (let i = 0; i < lit; i++) c.fillRect(Math.round(bx + i * (sw + gap)), by, Math.ceil(sw), bh)
    }
    // The switches you have to remember, and the radio, along the bottom left.
    c.font = `${Math.round(6 * px)}px "Press Start 2P", monospace`
    c.textAlign = 'left'
    // A one-pixel dark outline on every side: these sit over tarmac, kerbs and white lane paint,
    // and a drop shadow alone leaves them illegible against the bright half of that.
    const small = (text: string, x: number, y: number, colour: string) => {
      c.fillStyle = 'rgba(16,6,0,0.9)'
      for (const [ox, oy] of [
        [-px, 0],
        [px, 0],
        [0, -px],
        [0, px],
        [px, px],
      ])
        c.fillText(text, x + ox, y + oy)
      c.fillStyle = colour
      c.fillText(text, x, y)
    }
    // A switch that ought to be on right now blinks, the way the arcade flashed its prompts.
    const blink = Math.floor(this.clock * 3) % 2 === 0
    const sw = (on: boolean, need: boolean, onColour: string) => (on ? onColour : need ? (blink ? '#ffd93a' : 'rgba(255,217,58,0.25)') : 'rgba(232,246,255,0.45)')
    const key = (s: string) => (s ? ` ${s}` : '')
    small(`LIGHTS${key(this.switchKeys.lights)}`, safe, H - safeB - 22 * px, sw(snap.hud.lights, this.needs.lights, '#5cff8a'))
    small(`WIPERS${key(this.switchKeys.wipers)}`, safe + 62 * px, H - safeB - 22 * px, sw(snap.hud.wipers, this.needs.wipers, '#6ab8ff'))
    if (this.station) small(`> ${this.station.toUpperCase()}`, safe, H - safeB - 8 * px, '#ffb3e6')
    if (this.viewHint) {
      // Chase: along the bottom edge. Cockpit: that edge is dashboard and the middle is the road you
      // are trying to see, so it stacks above the switches instead.
      if (this.cockpit) small(this.viewHint, safe, H - safeB - 36 * px, 'rgba(232,246,255,0.6)')
      else {
        c.textAlign = 'center'
        small(this.viewHint, W / 2, H - safeB, 'rgba(232,246,255,0.6)')
        c.textAlign = 'left'
      }
    }
    // A fork ahead: which way you are leaning.
    if (snap.forkT >= 0) {
      const on = '#7dff9a'
      const off = 'rgba(232,246,255,0.3)'
      value('< LEFT', 30 * px, H * 0.42, 14, 'left', snap.forkSide < 0 ? on : off)
      value('RIGHT >', W - 30 * px, H * 0.42, 14, 'right', snap.forkSide > 0 ? on : off)
    }
    // Messages (stage names, wrecks, near misses) across the middle — clear of the clock above.
    if (this.messageTimer > 0 && this.message) {
      const colour = this.messageClass === 'bad' ? '#ff3b5c' : this.messageClass === 'gold' ? '#ffd93a' : this.messageClass === 'good' ? '#7dff9a' : '#ffffff'
      const my = Math.round(H * 0.44)
      value(this.message, W / 2, my, 18, 'center', colour)
      // A near miss glints: the DOM HUD did this with a CSS sparkle, which the buffer can't borrow, so
      // here they are as pixel stars that pop and fade around the bonus.
      if (this.messageClass === 'gold') {
        const age = this.messageLength - this.messageTimer
        const width = c.measureText(this.message).width
        for (const [dx, dy, delay] of [
          [-width * 0.4, -11 * px, 0.02],
          [width * 0.38, 3 * px, 0.14],
          [-width * 0.12, 8 * px, 0.26],
          [width * 0.14, -14 * px, 0.36],
        ]) {
          const k = (age - delay) / 0.4
          if (k < 0 || k > 1) continue
          const r = Math.round((3 + 9 * k) * px)
          const bar = Math.max(2, Math.round(2 * px))
          const gx = Math.round(W / 2 + dx)
          const gy = Math.round(my + dy)
          const fade = (1 - k * k).toFixed(2)
          c.fillStyle = `rgba(255,176,0,${fade})`
          c.fillRect(gx - r - bar, gy - bar, (r + bar) * 2, bar * 2)
          c.fillRect(gx - bar, gy - r - bar, bar * 2, (r + bar) * 2)
          c.fillStyle = `rgba(255,250,214,${fade})`
          c.fillRect(gx - r, gy - bar / 2, r * 2, bar)
          c.fillRect(gx - bar / 2, gy - r, bar, r * 2)
          c.fillRect(gx - bar, gy - bar, bar * 2, bar * 2)
        }
      }
    }
  }
}
