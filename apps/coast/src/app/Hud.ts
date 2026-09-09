// DOM HUD: time (big, centre), score, stage/route, speed + gear, turbo, fork arrows.

import type { Snapshot } from '../sim/Snapshot'

export class Hud {
  readonly el: HTMLElement
  private readonly time: HTMLElement
  private readonly score: HTMLElement
  private readonly stage: HTMLElement
  private readonly speed: HTMLElement
  private readonly unit: HTMLElement
  private readonly gear: HTMLElement
  private readonly turbo: HTMLElement
  private readonly boostKey: HTMLElement
  private readonly message: HTMLElement
  private readonly fork: HTMLElement
  private readonly station: HTMLElement
  private readonly lights: HTMLElement
  private readonly wipers: HTMLElement
  private readonly viewhint: HTMLElement
  private acc = 0
  private messageTimer = 0
  units: 'kmh' | 'mph' = 'kmh'

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    this.el.className = 'hud'
    this.el.innerHTML = `
      <div class="score"><span class="label">SCORE</span><span class="value" data-score>0</span></div>
      <div class="time" data-time>75</div>
      <div class="stage"><span class="label">STAGE</span><span class="value" data-stage>1</span></div>
      <div class="message" data-message></div>
      <div class="fork" data-fork><span class="l">◄ LEFT</span><span class="r">RIGHT ►</span></div>
      <div class="speedo"><span class="value" data-speed>0</span><span class="unit" data-unit>KM/H</span><span class="gear" data-gear>HI</span><div class="turbo" data-turbo></div><span class="boostkey" data-boostkey></span></div>
      <div class="switches"><span data-lights>● LIGHTS</span><span data-wipers>● WIPERS</span></div>
      <div class="station" data-station></div>
      <div class="viewhint" data-viewhint></div>`
    parent.appendChild(this.el)
    const q = (s: string) => this.el.querySelector(s) as HTMLElement
    this.time = q('[data-time]')
    this.score = q('[data-score]')
    this.stage = q('[data-stage]')
    this.speed = q('[data-speed]')
    this.unit = q('[data-unit]')
    this.gear = q('[data-gear]')
    this.turbo = q('[data-turbo]')
    this.boostKey = q('[data-boostkey]')
    this.message = q('[data-message]')
    this.fork = q('[data-fork]')
    this.station = q('[data-station]')
    this.lights = q('[data-lights]')
    this.wipers = q('[data-wipers]')
    this.viewhint = q('[data-viewhint]')
  }
  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
  }
  setViewHint(view: string): void {
    this.viewhint.textContent = view === 'cockpit' ? 'C · CHASE VIEW' : 'C · COCKPIT VIEW'
  }
  /** Label the manual switches with the key (or pad button) that works them. */
  setSwitchLabels(wipers: string, lights: string, turbo = ''): void {
    this.lights.textContent = `● LIGHTS · ${lights}`
    this.wipers.textContent = `● WIPERS · ${wipers}`
    // Nobody finds a boost button they were never told about.
    this.boostKey.textContent = turbo ? `BOOST · ${turbo}` : ''
  }
  /** Flag a switch you should have on right now (rain without wipers, night without lights). */
  setSwitchNeeds(wipers: boolean, lights: boolean): void {
    this.wipers.classList.toggle('need', wipers)
    this.lights.classList.toggle('need', lights)
  }
  setStation(name: string): void {
    this.station.textContent = name ? `♫ ${name}` : ''
  }
  showMessage(text: string, seconds = 1.6, cls = ''): void {
    this.message.textContent = text
    this.message.className = `message show ${cls}`
    this.messageTimer = seconds
  }
  update(snap: Snapshot, dt: number, cockpit: boolean): void {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt
      if (this.messageTimer <= 0) this.message.classList.remove('show')
    }
    this.fork.classList.toggle('show', snap.forkT >= 0)
    this.fork.classList.toggle('left', snap.forkSide < 0)
    this.fork.classList.toggle('right', snap.forkSide > 0)
    this.time.classList.toggle('low', snap.hud.time < 10)
    this.time.classList.toggle('bonus', snap.hud.checkpointFlash > 0)
    this.el.classList.toggle('cockpit', cockpit)
    this.lights.classList.toggle('on', snap.hud.lights)
    this.wipers.classList.toggle('on', snap.hud.wipers)
    this.acc += dt
    if (this.acc < 1 / 20) return
    this.acc = 0
    this.time.textContent = String(Math.ceil(snap.hud.time))
    this.score.textContent = snap.hud.score.toLocaleString()
    this.stage.textContent = `${snap.hud.stage}/${snap.hud.stagesTotal}`
    const v = this.units === 'kmh' ? snap.hud.speedKmh : snap.hud.speedKmh / 1.609
    this.speed.textContent = String(Math.round(v))
    this.unit.textContent = this.units === 'kmh' ? 'KM/H' : 'MPH'
    this.gear.textContent = snap.hud.gear === 1 ? 'HI' : 'LO'
    // Boosts in hand, one pip each, so you can see what you are spending.
    const max = Math.max(1, snap.hud.turboMax)
    if (this.turbo.childElementCount !== max) {
      this.turbo.innerHTML = ''
      for (let i = 0; i < max; i++) this.turbo.appendChild(document.createElement('i'))
    }
    for (let i = 0; i < max; i++) this.turbo.children[i].className = i < snap.hud.turbo ? 'on' : ''
    this.turbo.classList.toggle('active', snap.hud.turboActive)
  }
}
