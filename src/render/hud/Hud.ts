// DOM HUD for 2D play. Peripheral first: shield is a screen-edge rim and the
// timer is big and centred, because the player is looking down the tunnel,
// not at a corner. Updates are throttled to 30 Hz — text churn is not free.

import type { SimSnapshot } from '../../sim/SimSnapshot'
import { LASER_HEAT_MAX, SHIELD_MAX, SHOCKWAVE_MAX_CHARGES } from '../../sim/Tuning'

export class Hud {
  readonly el: HTMLElement
  private readonly timer: HTMLElement
  private readonly speed: HTMLElement
  private readonly score: HTMLElement
  private readonly combo: HTMLElement
  private readonly shieldBar: HTMLElement
  private readonly heatBar: HTMLElement
  private readonly charges: HTMLElement[] = []
  private readonly rim: HTMLElement
  private readonly message: HTMLElement
  private readonly gates: HTMLElement
  private readonly progress: HTMLElement
  private readonly flash: HTMLElement
  private acc = 0
  private messageTimer = 0
  private flashLevel = 0
  private lastGate = -1
  private gateFlash = 0

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = `
      <div class="rim"></div>
      <div class="flash"></div>
      <div class="top">
        <div class="score"><span class="label">SCORE</span><span class="value" data-score>0</span><span class="combo" data-combo></span></div>
        <div class="timer" data-timer>60.0</div>
        <div class="gates"><span class="label">GATES</span><span class="value" data-gates>0/0</span></div>
      </div>
      <div class="message" data-message></div>
      <div class="bottom">
        <div class="meter shield"><span class="label">SHIELD</span><div class="bar"><div class="fill" data-shield></div></div></div>
        <div class="speed"><span class="value" data-speed>0</span><span class="unit">MPH</span></div>
        <div class="meter heat"><span class="label">LASER</span><div class="bar"><div class="fill" data-heat></div></div></div>
      </div>
      <div class="charges" data-charges></div>
      <div class="progress"><div class="fill" data-progress></div></div>
    `
    parent.appendChild(this.el)
    const q = (sel: string) => this.el.querySelector(sel) as HTMLElement
    this.timer = q('[data-timer]')
    this.speed = q('[data-speed]')
    this.score = q('[data-score]')
    this.combo = q('[data-combo]')
    this.shieldBar = q('[data-shield]')
    this.heatBar = q('[data-heat]')
    this.rim = q('.rim')
    this.message = q('[data-message]')
    this.gates = q('[data-gates]')
    this.progress = q('[data-progress]')
    this.flash = q('.flash')
    const chargeBox = q('[data-charges]')
    for (let i = 0; i < SHOCKWAVE_MAX_CHARGES; i++) {
      const c = document.createElement('div')
      c.className = 'charge'
      chargeBox.appendChild(c)
      this.charges.push(c)
    }
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
  }

  showMessage(text: string, seconds = 1.6, cls = ''): void {
    this.message.textContent = text
    this.message.className = `message show ${cls}`
    this.messageTimer = seconds
  }

  hitFlash(strength: number): void {
    this.flashLevel = Math.max(this.flashLevel, strength)
  }

  update(snap: SimSnapshot, dt: number, mph: number): void {
    // Rim and flash every frame (cheap style writes), text at 30 Hz.
    const h = snap.hud
    const shieldT = h.shield / SHIELD_MAX
    const low = shieldT < 0.35 ? (0.35 - shieldT) / 0.35 : 0
    const pulse = low > 0 ? 0.6 + 0.4 * Math.sin(performance.now() * 0.012) : 0
    this.rim.style.opacity = String(Math.min(1, low * pulse * 0.9 + this.flashLevel * 0.6))
    this.rim.style.setProperty('--rim', this.flashLevel > 0.3 ? '#ff3b5c' : low > 0 ? '#ff3b5c' : '#25e8ff')
    this.flash.style.opacity = String(this.flashLevel * 0.35)
    this.flashLevel = Math.max(0, this.flashLevel - dt * 4)
    if (this.messageTimer > 0) {
      this.messageTimer -= dt
      if (this.messageTimer <= 0) this.message.classList.remove('show')
    }
    if (h.gatesPassed !== this.lastGate) {
      if (this.lastGate >= 0) this.gateFlash = 1
      this.lastGate = h.gatesPassed
    }
    this.gateFlash = Math.max(0, this.gateFlash - dt * 1.5)
    this.timer.classList.toggle('bonus', this.gateFlash > 0)
    this.timer.classList.toggle('low', h.timer < 10)

    this.acc += dt
    if (this.acc < 1 / 30) return
    this.acc = 0
    this.timer.textContent = h.timer.toFixed(1)
    this.speed.textContent = String(Math.round(mph))
    this.score.textContent = h.score.toLocaleString()
    this.combo.textContent = h.combo > 1.01 ? `×${h.combo.toFixed(2).replace(/\.?0+$/, '')}` : ''
    this.shieldBar.style.width = `${shieldT * 100}%`
    this.shieldBar.classList.toggle('low', low > 0)
    this.heatBar.style.width = `${(h.heat / LASER_HEAT_MAX) * 100}%`
    this.heatBar.classList.toggle('locked', h.heatLocked)
    for (let i = 0; i < this.charges.length; i++) this.charges[i].classList.toggle('on', i < h.charges)
    this.gates.textContent = `${h.gatesPassed}/${h.gatesTotal}`
    this.progress.style.width = `${h.progress * 100}%`
  }
}
