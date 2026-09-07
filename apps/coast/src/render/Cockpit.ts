// First-person view from inside a Group-6-style prototype: you sit low behind
// a wraparound screen, the two fender humps fill the lower corners, a thin
// rim wheel, three round gauges, a mirror with dice, and a single central wiper
// pivoting from below the screen. Rain lands on the glass as droplets and haze
// in an offscreen canvas that the wiper's sweep wipes clean (Rad Mobile did
// this, and it is the whole reason the wiper switch exists).
// Drawn to a canvas texture a few times a second.

import { CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, NearestFilter, PlaneGeometry } from 'three'
import type { Snapshot } from '../sim/Snapshot'
import { RAIN_DROPS_PER_SEC, RAIN_HAZE_PER_SEC, WIPER_RATE } from './RenderTuning'
import type { Livery } from './procgen'

const W = 1280
const H = 560
/** Single wiper: pivot just below the screen, long blade, sweep half-angle from vertical, and where it parks. */
const WIPER_PIVOT_Y = H + 30
const WIPER_LEN = H * 0.98
const WIPER_SWEEP = 1.12
const WIPER_PARK = -1.36

export class Cockpit {
  readonly mesh: Mesh
  private readonly canvas = document.createElement('canvas')
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: CanvasTexture
  private diceAngle = 0
  private diceVel = 0
  private acc = 0
  private lastX = 0
  private readonly glass = document.createElement('canvas')
  private readonly gctx: CanvasRenderingContext2D
  private wiperPhase = 0
  private wiperAngle = WIPER_PARK
  private dropAcc = 0
  private seed = 1
  livery: Livery = { body: 0x7fc6e8, stripe: 0xff7a1a, number: '17' }
  rain = false
  night = false

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d')!
    this.glass.width = W
    this.glass.height = H
    this.gctx = this.glass.getContext('2d')!
    this.tex = new CanvasTexture(this.canvas)
    this.mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false }))
    this.mesh.frustumCulled = false
    this.mesh.visible = false
  }

  setRetro(retro: boolean): void {
    this.tex.minFilter = this.tex.magFilter = retro ? NearestFilter : LinearFilter
    this.tex.needsUpdate = true
  }

  /** The overlay covers the whole logical screen; most of it is transparent. */
  layout(width: number, height: number): void {
    this.mesh.scale.set(width, height, 1)
    this.mesh.position.set(width / 2, height / 2, 0)
  }

  update(snap: Snapshot, dt: number): void {
    const lateralAccel = (snap.x - this.lastX) / Math.max(dt, 1e-3)
    this.lastX = snap.x
    this.diceVel += (-this.diceAngle * 30 - this.diceVel * 3 + lateralAccel * 4 + (snap.crashT > 0 ? Math.sin(snap.time * 40) * 20 : 0)) * dt
    this.diceAngle += this.diceVel * dt
    this.acc += dt
    if (this.acc < 1 / 24) return
    const step = this.acc
    this.acc = 0
    this.updateGlass(step, snap)
    const c = this.ctx
    c.clearRect(0, 0, W, H)
    c.save()
    if (snap.wreck) {
      // Crushed: the whole cabin lurches and sags, and the screen cracks.
      const t = snap.crashT
      const jolt = t < 0.7 ? Math.sin(t * 90) * 26 * (1 - t) : 0
      c.translate(jolt, Math.min(1, t / 0.4) * 70 + jolt * 0.5)
      c.rotate(Math.min(1, t / 0.4) * -0.09 + jolt * 0.002)
    }
    // Wet glass first: everything in the cabin is drawn over it.
    c.drawImage(this.glass, 0, 0)
    if (snap.wreck) this.drawCracks(c, snap.crashT)
    this.drawWiper(c)
    const bodyDark = shade(this.livery.body, 0.42)
    const bodyLight = shade(this.livery.body, 0.95)
    const bodyMid = shade(this.livery.body, 0.72)
    const stripe = '#' + this.livery.stripe.toString(16).padStart(6, '0')

    // Bonnet: a low, wide deck that dives away between the fenders (917-style),
    // with the central stripe running off toward the nose.
    const noseGrad = c.createLinearGradient(0, H - 130, 0, H)
    noseGrad.addColorStop(0, bodyMid)
    noseGrad.addColorStop(1, bodyDark)
    c.fillStyle = noseGrad
    c.beginPath()
    c.moveTo(0, H)
    c.lineTo(0, H - 60)
    c.quadraticCurveTo(W * 0.3, H - 120, W / 2, H - 118)
    c.quadraticCurveTo(W * 0.7, H - 120, W, H - 60)
    c.lineTo(W, H)
    c.closePath()
    c.fill()
    c.fillStyle = stripe
    c.beginPath()
    c.moveTo(W / 2 - 46, H)
    c.lineTo(W / 2 - 16, H - 116)
    c.lineTo(W / 2 + 16, H - 116)
    c.lineTo(W / 2 + 46, H)
    c.closePath()
    c.fill()
    // Fender humps: tall rounded swells right out at the sides, lit from above,
    // standing well proud of the bonnet between them.
    for (const side of [-1, 1]) {
      const cx = W / 2 + side * 560
      const grad = c.createRadialGradient(cx - side * 40, H - 120, 40, cx, H + 40, 380)
      grad.addColorStop(0, bodyLight)
      grad.addColorStop(0.45, bodyMid)
      grad.addColorStop(1, bodyDark)
      c.fillStyle = grad
      c.beginPath()
      c.moveTo(cx - side * 300, H)
      c.bezierCurveTo(cx - side * 290, H - 130, cx - side * 160, H - 240, cx + side * 20, H - 245)
      c.bezierCurveTo(cx + side * 200, H - 240, cx + side * 300, H - 140, cx + side * 320, H)
      c.closePath()
      c.fill()
      // Highlight line along the hump.
      c.strokeStyle = 'rgba(255,255,255,0.18)'
      c.lineWidth = 4
      c.beginPath()
      c.moveTo(cx - side * 240, H - 110)
      c.bezierCurveTo(cx - side * 120, H - 220, cx + side * 100, H - 225, cx + side * 260, H - 130)
      c.stroke()
    }
    // Windscreen frame: thin A-pillars at the edges and a header bar with the mirror.
    c.fillStyle = '#15161c'
    c.fillRect(0, 0, 26, H)
    c.fillRect(W - 26, 0, 26, H)
    c.fillRect(0, 0, W, 22)
    // Dash: a dark cowl behind the wheel with three round gauges.
    c.fillStyle = '#1b1c22'
    c.beginPath()
    c.moveTo(W / 2 - 360, H)
    c.lineTo(W / 2 - 320, H - 120)
    c.quadraticCurveTo(W / 2, H - 170, W / 2 + 320, H - 120)
    c.lineTo(W / 2 + 360, H)
    c.closePath()
    c.fill()
    gauge(c, W / 2 - 200, H - 60, 62, snap.speed / snap.maxSpeed, String(Math.round(snap.hud.speedKmh)), 'KM/H', snap.speed / snap.maxSpeed > 0.92)
    gauge(c, W / 2, H - 78, 78, ((snap.speed / snap.maxSpeed) * 4) % 1 * 0.8 + 0.15, snap.hud.gear === 1 ? 'HI' : 'LO', 'RPM', snap.hud.turboActive)
    gauge(c, W / 2 + 200, H - 60, 62, snap.hud.turbo, snap.hud.turboActive ? 'GO' : '', 'TURBO', snap.hud.turboActive)
    // Telltales on the dash: the two switches you have to remember to flick.
    telltale(c, W / 2 - 300, H - 40, snap.lightsOn, '#5cff8a', 'LIGHTS')
    telltale(c, W / 2 + 300, H - 40, snap.wipersOn, '#6ab8ff', 'WIPERS')
    // Wheel: thin rim, three spokes, turns with the steer.
    c.save()
    c.translate(W / 2, H + 60)
    c.rotate(snap.steer * 1.1)
    c.strokeStyle = '#0c0c10'
    c.lineWidth = 22
    c.beginPath()
    c.arc(0, 0, 190, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#3a2a1e'
    c.lineWidth = 14
    c.beginPath()
    c.arc(0, 0, 190, 0, Math.PI * 2)
    c.stroke()
    c.strokeStyle = '#8a8f98'
    c.lineWidth = 10
    for (const a of [Math.PI * 0.12, Math.PI * 0.88, Math.PI * 1.5]) {
      c.beginPath()
      c.moveTo(0, 0)
      c.lineTo(Math.cos(a) * 185, Math.sin(a) * 185)
      c.stroke()
    }
    c.fillStyle = '#15161c'
    c.beginPath()
    c.arc(0, 0, 40, 0, Math.PI * 2)
    c.fill()
    c.restore()
    // Mirror with the road behind implied (dark glass), dice hanging beneath.
    const mx = W * 0.68
    c.fillStyle = '#0d0e12'
    c.fillRect(mx - 150, 24, 300, 70)
    c.fillStyle = this.night ? '#101828' : '#5a86b8'
    c.fillRect(mx - 142, 30, 284, 58)
    const px = mx
    const py = 94
    const len = 80
    const dx = Math.sin(this.diceAngle) * len
    const dy = Math.cos(this.diceAngle) * len
    c.strokeStyle = '#ddd'
    c.lineWidth = 2
    c.beginPath()
    c.moveTo(px, py)
    c.lineTo(px + dx, py + dy)
    c.stroke()
    c.save()
    c.translate(px + dx, py + dy)
    c.rotate(this.diceAngle)
    for (const [ox, oy, col] of [[-18, 0, '#ff3b5c'], [14, 10, '#ffffff']] as const) {
      c.fillStyle = col
      c.fillRect(ox - 16, oy - 16, 32, 32)
      c.fillStyle = col === '#ffffff' ? '#222' : '#fff'
      for (const [qx, qy] of [[-8, -8], [8, 8], [0, 0]]) c.fillRect(ox + qx - 2, oy + qy - 2, 5, 5)
    }
    c.restore()
    c.restore()
    this.tex.needsUpdate = true
  }

  private drawCracks(c: CanvasRenderingContext2D, t: number): void {
    const cx = W * 0.42
    const cy = H * 0.3
    const n = Math.min(14, Math.floor(t * 40))
    c.strokeStyle = 'rgba(240,248,255,0.85)'
    c.lineWidth = 2
    for (let i = 0; i < n; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.3
      const len = 180 + ((i * 97) % 160)
      c.beginPath()
      c.moveTo(cx, cy)
      c.lineTo(cx + Math.cos(a) * len * 0.5, cy + Math.sin(a) * len * 0.5 + 20)
      c.lineTo(cx + Math.cos(a + 0.15) * len, cy + Math.sin(a + 0.15) * len)
      c.stroke()
    }
    c.strokeStyle = 'rgba(240,248,255,0.5)'
    c.beginPath()
    c.arc(cx, cy, 60 + t * 40, 0, Math.PI * 2)
    c.stroke()
  }

  /** Droplets and haze build up while it rains; the wiper clears the wedge it just swept. */
  private updateGlass(step: number, snap: Snapshot): void {
    const g = this.gctx
    if (this.rain) {
      // More drops the faster you go: the screen is punching through the rain.
      this.dropAcc += RAIN_DROPS_PER_SEC * step * (0.6 + Math.min(1.4, snap.speed / 60))
      while (this.dropAcc >= 1) {
        this.dropAcc--
        const x = 30 + this.rnd() * (W - 60)
        const y = 24 + this.rnd() * (H - 150)
        const r = 2 + this.rnd() * 4.5
        const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
        grad.addColorStop(0, 'rgba(230,240,255,0.55)')
        grad.addColorStop(0.7, 'rgba(180,200,230,0.28)')
        grad.addColorStop(1, 'rgba(160,180,210,0.0)')
        g.fillStyle = grad
        g.beginPath()
        g.ellipse(x, y, r, r * 1.35, 0, 0, Math.PI * 2)
        g.fill()
      }
      g.fillStyle = `rgba(196,208,224,${Math.min(0.08, RAIN_HAZE_PER_SEC * step).toFixed(4)})`
      g.fillRect(0, 0, W, H)
    }
    // Wiper motion: a smooth back-and-forth when on, a slow return to the park position when off.
    const prev = this.wiperAngle
    if (snap.wipersOn) {
      this.wiperPhase += step * WIPER_RATE * Math.PI
      this.wiperAngle = Math.sin(this.wiperPhase) * WIPER_SWEEP
    } else {
      this.wiperPhase = -Math.PI / 2 + (Math.asin(Math.max(-1, Math.min(1, this.wiperAngle / WIPER_SWEEP))) + Math.PI / 2)
      this.wiperAngle += (WIPER_PARK - this.wiperAngle) * Math.min(1, step * 3)
    }
    if (Math.abs(this.wiperAngle - prev) > 1e-4) {
      // Clear the swept wedge (angles measured from straight up; canvas angle = θ − π/2).
      const a0 = Math.min(prev, this.wiperAngle) - Math.PI / 2 - 0.015
      const a1 = Math.max(prev, this.wiperAngle) - Math.PI / 2 + 0.015
      g.save()
      g.globalCompositeOperation = 'destination-out'
      g.fillStyle = '#000'
      g.beginPath()
      g.moveTo(W / 2, WIPER_PIVOT_Y)
      g.arc(W / 2, WIPER_PIVOT_Y, WIPER_LEN, a0, a1)
      g.closePath()
      g.fill()
      g.restore()
    }
  }

  private drawWiper(c: CanvasRenderingContext2D): void {
    const a = this.wiperAngle
    const dx = Math.sin(a)
    const dy = -Math.cos(a)
    const px = W / 2
    const py = WIPER_PIVOT_Y
    // Arm from the pivot, blade along the outer two thirds.
    c.strokeStyle = '#0b0c10'
    c.lineWidth = 7
    c.beginPath()
    c.moveTo(px + dx * WIPER_LEN * 0.18, py + dy * WIPER_LEN * 0.18)
    c.lineTo(px + dx * WIPER_LEN * 0.98, py + dy * WIPER_LEN * 0.98)
    c.stroke()
    c.strokeStyle = '#1a1c22'
    c.lineWidth = 12
    c.beginPath()
    c.moveTo(px + dx * WIPER_LEN * 0.34, py + dy * WIPER_LEN * 0.34)
    c.lineTo(px + dx * WIPER_LEN, py + dy * WIPER_LEN)
    c.stroke()
  }

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0
    return this.seed / 4294967296
  }
}

function telltale(c: CanvasRenderingContext2D, x: number, y: number, on: boolean, col: string, label: string): void {
  c.fillStyle = on ? col : '#2a2c34'
  c.beginPath()
  c.arc(x, y, 7, 0, Math.PI * 2)
  c.fill()
  if (on) {
    c.fillStyle = col.replace(')', ',0.35)').replace('#', 'rgba(').replace(/^rgba\(([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2}),/i, (_m, r, g, b) => `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},`)
    c.beginPath()
    c.arc(x, y, 13, 0, Math.PI * 2)
    c.fill()
  }
  c.fillStyle = on ? '#e8f6ff' : '#6a6e7a'
  c.textAlign = 'center'
  c.font = '10px "Righteous", ui-sans-serif, system-ui'
  c.fillText(label, x, y + 22)
}

function gauge(c: CanvasRenderingContext2D, x: number, y: number, r: number, t: number, big: string, small: string, hot: boolean): void {
  c.fillStyle = '#0a0a0e'
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = '#3a3c48'
  c.lineWidth = 5
  c.beginPath()
  c.arc(x, y, r - 4, Math.PI * 0.75, Math.PI * 2.25)
  c.stroke()
  c.strokeStyle = hot ? '#ff5a3c' : '#ffb03c'
  c.lineWidth = 6
  c.beginPath()
  c.arc(x, y, r - 4, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, t)))
  c.stroke()
  // Needle.
  const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, t))
  c.strokeStyle = '#ff3b3b'
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(x, y)
  c.lineTo(x + Math.cos(a) * (r - 10), y + Math.sin(a) * (r - 10))
  c.stroke()
  c.fillStyle = '#e8f6ff'
  c.textAlign = 'center'
  c.font = `${Math.round(r * 0.44)}px "Racing Sans One", "Arial Black", sans-serif`
  c.fillText(big, x, y + r * 0.35)
  c.font = `${Math.round(r * 0.2)}px "Righteous", ui-sans-serif, system-ui`
  c.fillStyle = '#9fb8c8'
  c.fillText(small, x, y + r * 0.62)
}

function shade(hex: number, k: number): string {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k))
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k))
  const b = Math.min(255, Math.round((hex & 255) * k))
  return `rgb(${r},${g},${b})`
}
