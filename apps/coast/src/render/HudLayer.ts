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
  private station = ''
  units: 'kmh' | 'mph' = 'kmh'
  /** Hide the speed block in the cockpit view, where the dashboard shows it. */
  cockpit = false

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
    this.acc = REPAINT_HZ
  }

  setStation(name: string): void {
    this.station = name
    this.acc = REPAINT_HZ
  }

  update(snap: Snapshot, dt: number): void {
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
    label('SCORE', safe, safe + 8 * px, 'left')
    value(snap.hud.score.toLocaleString(), safe, safe + 25 * px, 14, 'left')
    const low = snap.hud.time < 10
    value(String(Math.ceil(snap.hud.time)), W / 2, safe + 30 * px, 28, 'center', snap.hud.checkpointFlash > 0 ? '#7dff9a' : low ? '#ff3b5c' : '#ffd93a')
    label('STAGE', W - safe, safe + 8 * px, 'right')
    value(`${snap.hud.stage}/${snap.hud.stagesTotal}`, W - safe, safe + 25 * px, 14, 'right')
    // Speed, bottom right: the number, its unit beneath, the gear alongside.
    if (!this.cockpit) {
      const shown = this.units === 'kmh' ? snap.hud.speedKmh : snap.hud.speedKmh / 1.609
      value(String(Math.round(shown)), W - safe, H - safe - 13 * px, 24, 'right')
      label(this.units === 'kmh' ? 'KM/H' : 'MPH', W - safe, H - safe - 2 * px, 'right')
      value(snap.hud.gear === 1 ? 'HI' : 'LO', W - safe - 54 * px, H - safe - 13 * px, 12, 'right', '#ff8a3c')
    }
    // The switches you have to remember, and the radio, along the bottom left.
    c.font = `${Math.round(6 * px)}px "Press Start 2P", monospace`
    c.textAlign = 'left'
    // A pixel of shadow under each: these sit over bright tarmac and kerbs.
    const small = (text: string, x: number, y: number, colour: string) => {
      c.fillStyle = 'rgba(20,6,0,0.85)'
      c.fillText(text, x + px, y + px)
      c.fillStyle = colour
      c.fillText(text, x, y)
    }
    small('LIGHTS', safe, H - safe - 26 * px, snap.hud.lights ? '#5cff8a' : 'rgba(232,246,255,0.45)')
    small('WIPERS', safe + 52 * px, H - safe - 26 * px, snap.hud.wipers ? '#6ab8ff' : 'rgba(232,246,255,0.45)')
    if (this.station) small(`> ${this.station.toUpperCase()}`, safe, H - safe - 10 * px, '#ffb3e6')
    // A fork ahead: which way you are leaning.
    if (snap.forkT >= 0) {
      const on = '#7dff9a'
      const off = 'rgba(232,246,255,0.3)'
      value('< LEFT', 30 * px, H * 0.42, 14, 'left', snap.forkSide < 0 ? on : off)
      value('RIGHT >', W - 30 * px, H * 0.42, 14, 'right', snap.forkSide > 0 ? on : off)
    }
    // Messages (stage names, wrecks, near misses) across the middle.
    if (this.messageTimer > 0 && this.message) {
      const colour = this.messageClass === 'bad' ? '#ff3b5c' : this.messageClass === 'gold' ? '#ffd93a' : this.messageClass === 'good' ? '#7dff9a' : '#ffffff'
      value(this.message, W / 2, H * 0.3, 18, 'center', colour)
    }
  }
}
