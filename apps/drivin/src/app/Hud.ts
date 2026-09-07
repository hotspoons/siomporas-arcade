// DOM HUD: speed, gear, lap timer, lap list, minimap, messages.

import type { Snapshot } from '../sim/Snapshot'
import type { Track } from '../sim/Track'
import { makeLaneFrame } from '../sim/PathTable'

const MPH = 2.23694
const KMH = 3.6

export function fmtTime(t: number): string {
  if (t <= 0) return '--:--.-'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

export class Hud {
  readonly el: HTMLElement
  private readonly speed: HTMLElement
  private readonly unit: HTMLElement
  private readonly gear: HTMLElement
  private readonly lap: HTMLElement
  private readonly lapTime: HTMLElement
  private readonly best: HTMLElement
  private readonly last: HTMLElement
  private readonly message: HTMLElement
  private readonly mini: HTMLCanvasElement
  private readonly miniCtx: CanvasRenderingContext2D
  private readonly rpm: HTMLElement
  private acc = 0
  private messageTimer = 0
  private miniPath: Path2D | null = null
  private miniScale = 1
  private miniMin = { x: 0, z: 0 }
  units: 'mph' | 'kmh' = 'mph'

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = `
      <div class="laps"><span class="label">LAP</span><span class="value" data-lap>1/3</span></div>
      <div class="timer" data-laptime>0:00.0</div>
      <div class="times"><div><span class="label">BEST</span><span data-best>--:--.-</span></div><div><span class="label">LAST</span><span data-last>--:--.-</span></div></div>
      <div class="message" data-message></div>
      <div class="speedo"><div class="rpm"><div class="fill" data-rpm></div></div><span class="value" data-speed>0</span><span class="unit" data-unit>MPH</span><span class="gear" data-gear>1</span></div>
      <canvas class="minimap" width="220" height="220"></canvas>
    `
    parent.appendChild(this.el)
    const q = (s: string) => this.el.querySelector(s) as HTMLElement
    this.speed = q('[data-speed]')
    this.unit = q('[data-unit]')
    this.gear = q('[data-gear]')
    this.lap = q('[data-lap]')
    this.lapTime = q('[data-laptime]')
    this.best = q('[data-best]')
    this.last = q('[data-last]')
    this.message = q('[data-message]')
    this.rpm = q('[data-rpm]')
    this.mini = this.el.querySelector('.minimap') as HTMLCanvasElement
    this.miniCtx = this.mini.getContext('2d')!
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
  }

  showMessage(text: string, seconds = 1.6, cls = ''): void {
    this.message.textContent = text
    this.message.className = `message show ${cls}`
    this.messageTimer = seconds
  }

  /** Pre-draw the track outline for the minimap. */
  setTrack(track: Track): void {
    const f = makeLaneFrame()
    let minX = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (const l of track.lanes) {
      minX = Math.min(minX, l.table.minX)
      maxX = Math.max(maxX, l.table.maxX)
      minZ = Math.min(minZ, l.table.minZ)
      maxZ = Math.max(maxZ, l.table.maxZ)
    }
    const pad = 14
    const size = this.mini.width - pad * 2
    this.miniScale = size / Math.max(1, maxX - minX, maxZ - minZ)
    this.miniMin = { x: minX, z: minZ }
    const path = new Path2D()
    for (const l of track.lanes) {
      for (let s = 0; s <= l.table.length; s += 4) {
        l.table.frameAt(s, f)
        const x = pad + (f.pos.x - minX) * this.miniScale
        const y = this.mini.height - pad - (f.pos.z - minZ) * this.miniScale
        if (s === 0) path.moveTo(x, y)
        else path.lineTo(x, y)
      }
    }
    this.miniPath = path
  }

  update(snap: Snapshot, dt: number, targetLaps: number): void {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt
      if (this.messageTimer <= 0) this.message.classList.remove('show')
    }
    this.acc += dt
    if (this.acc < 1 / 30) return
    this.acc = 0
    const h = snap.hud
    const v = h.speed * (this.units === 'mph' ? MPH : KMH)
    this.speed.textContent = String(Math.round(v))
    this.unit.textContent = this.units === 'mph' ? 'MPH' : 'KM/H'
    this.gear.textContent = snap.car.speed < -0.5 ? 'R' : String(h.gear)
    this.rpm.style.width = `${Math.round(h.rpm * 100)}%`
    this.lap.textContent = targetLaps > 0 ? `${Math.min(h.laps + 1, targetLaps)}/${targetLaps}` : `${h.laps + 1}`
    this.lapTime.textContent = fmtTime(h.lapTime)
    this.best.textContent = fmtTime(h.bestLap)
    this.last.textContent = fmtTime(h.lastLap)
    // Minimap.
    const c = this.miniCtx
    c.clearRect(0, 0, this.mini.width, this.mini.height)
    if (this.miniPath) {
      c.strokeStyle = 'rgba(232,246,255,0.55)'
      c.lineWidth = 3
      c.stroke(this.miniPath)
      const pad = 14
      const x = pad + (snap.car.pos.x - this.miniMin.x) * this.miniScale
      const y = this.mini.height - pad - (snap.car.pos.z - this.miniMin.z) * this.miniScale
      c.fillStyle = '#ff7a1a'
      c.beginPath()
      c.arc(x, y, 5, 0, Math.PI * 2)
      c.fill()
    }
  }
}
